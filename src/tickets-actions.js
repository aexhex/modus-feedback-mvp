// Изменение обращений: создание, статусы, комментарии, назначение, поддержка, дубликаты.
import {
  TYPES, PRIORITIES, STATUSES, TRANSITIONS, SLA_HOURS, LIMITS, addHours,
} from './config.js';
import { canProcess, canReassign } from './access.js';
import { badRequest, forbidden } from './http.js';
import { inTransaction } from './db.js';
import { resolveAssignee } from './routing.js';
import { notify } from './notifications.js';
import { getTicketRow, getVisibleTicketRow, isFinal } from './tickets-query.js';

function text(value, { field, min = 0, max, required = false }) {
  const str = typeof value === 'string' ? value.trim() : '';
  if (required && str.length === 0) throw badRequest(`Заполните поле «${field}»`);
  if (str.length > 0 && str.length < min) throw badRequest(`Поле «${field}»: минимум ${min} символов`);
  if (str.length > max) throw badRequest(`Поле «${field}»: максимум ${max} символов`);
  return str;
}

function oneOf(value, dict, field) {
  if (!Object.hasOwn(dict, value)) throw badRequest(`Недопустимое значение поля «${field}»`);
  return value;
}

export function addEvent(db, { ticketId, actorId, kind, body = null, from = null, to = null, internal = false, at }) {
  db.prepare(
    `INSERT INTO events (ticket_id, actor_id, kind, body, from_status, to_status, is_internal, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(ticketId, actorId, kind, body, from, to, internal ? 1 : 0, at);
}

function nextCode(db) {
  const { maxId } = db.prepare('SELECT COALESCE(MAX(id), 0) AS maxId FROM tickets').get();
  return `A-${String(maxId + 1).padStart(3, '0')}`;
}

function supporterIds(db, ticketId) {
  return db.prepare('SELECT user_id FROM supports WHERE ticket_id = ?').all(ticketId).map((r) => r.user_id);
}

export function validateNewTicket(db, input) {
  const type = oneOf(input.type, TYPES, 'Тип');
  const categoryId = Number(input.categoryId);
  const category = db.prepare('SELECT id FROM categories WHERE id = ? AND is_active = 1').get(categoryId);
  if (!category) throw badRequest('Выберите действующую категорию');
  return {
    type,
    categoryId,
    title: text(input.title, { field: 'Кратко', min: LIMITS.titleMin, max: LIMITS.titleMax, required: true }),
    description: text(input.description, {
      field: 'Описание', min: LIMITS.descriptionMin, max: LIMITS.descriptionMax, required: true,
    }),
    proposedSolution: text(input.proposedSolution, { field: 'Предлагаемое решение', max: LIMITS.solutionMax }) || null,
    priority: input.priority ? oneOf(input.priority, PRIORITIES, 'Приоритет') : 'medium',
    isAnonymous: input.isAnonymous === true,
  };
}

export function createTicket(db, user, input, now) {
  const data = validateNewTicket(db, input);
  return inTransaction(db, () => {
    const code = nextCode(db);
    const sla = SLA_HOURS[data.priority];
    const assignment = resolveAssignee(db, data.categoryId);
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO tickets (code, type, category_id, title, description, proposed_solution, priority, status,
           author_id, is_anonymous, department, assignee_id, created_at, updated_at, first_response_due, due_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        code, data.type, data.categoryId, data.title, data.description, data.proposedSolution, data.priority,
        user.id, data.isAnonymous ? 1 : 0, user.department, assignment.userId, now, now,
        addHours(now, sla.firstResponse), addHours(now, sla.resolve),
      );
    const ticketId = Number(lastInsertRowid);
    addEvent(db, { ticketId, actorId: user.id, kind: 'created', to: 'new', at: now });
    addEvent(db, { ticketId, actorId: null, kind: 'assigned', body: assignment.reason, at: now });
    notify(db, {
      userIds: [assignment.userId], ticketId, actorId: user.id, now,
      text: `Вам назначено обращение ${code}: ${data.title}`,
    });
    return ticketId;
  });
}

export function changeStatus(db, user, id, input, now) {
  const row = getVisibleTicketRow(db, user, id);
  if (!canProcess(user, row)) throw forbidden('Менять статус может только ответственный или руководитель');
  const target = oneOf(input.status, STATUSES, 'Статус');
  if (!TRANSITIONS[row.status].includes(target)) {
    throw badRequest(`Переход «${STATUSES[row.status]}» → «${STATUSES[target]}» недопустим`);
  }
  const comment = text(input.comment, { field: 'Комментарий', max: LIMITS.commentMax });
  const resolutionInput = text(input.resolution, { field: 'Результат', max: LIMITS.solutionMax });
  const resolution = resolutionInput || row.resolution;
  if (isFinal(target) && !resolution) {
    throw badRequest('Для итогового статуса зафиксируйте результат рассмотрения');
  }
  if (target === 'need_info' && !comment) throw badRequest('Сформулируйте вопрос автору');

  inTransaction(db, () => {
    db.prepare(
      `UPDATE tickets SET status = ?, resolution = ?, updated_at = ?,
         first_response_at = COALESCE(first_response_at, ?), resolved_at = ?
       WHERE id = ?`,
    ).run(target, resolution, now, now, isFinal(target) ? (row.resolved_at ?? now) : null, row.id);
    addEvent(db, {
      ticketId: row.id, actorId: user.id, kind: 'status', from: row.status, to: target,
      body: [comment, resolutionInput && `Результат: ${resolutionInput}`].filter(Boolean).join('\n') || null,
      at: now,
    });
    const recipients = isFinal(target) ? [row.author_id, ...supporterIds(db, row.id)] : [row.author_id];
    notify(db, {
      userIds: recipients, ticketId: row.id, actorId: user.id, now,
      text: `${row.code}: статус изменён на «${STATUSES[target]}»`,
    });
  });
}

export function addComment(db, user, id, input, now) {
  const row = getVisibleTicketRow(db, user, id);
  if (row.status === 'closed') throw badRequest('Обращение закрыто');
  const body = text(input.body, { field: 'Комментарий', max: LIMITS.commentMax, required: true });
  const processor = canProcess(user, row);
  const internal = input.internal === true;
  if (internal && !processor) throw forbidden('Внутренние заметки доступны только обработчикам');
  const isAuthor = row.author_id === user.id;

  inTransaction(db, () => {
    addEvent(db, { ticketId: row.id, actorId: user.id, kind: 'comment', body, internal, at: now });
    if (processor && !internal && !isAuthor && !row.first_response_at) {
      db.prepare('UPDATE tickets SET first_response_at = ? WHERE id = ?').run(now, row.id);
    }
    if (isAuthor && row.status === 'need_info') {
      db.prepare("UPDATE tickets SET status = 'in_review', updated_at = ? WHERE id = ?").run(now, row.id);
      addEvent(db, {
        ticketId: row.id, actorId: null, kind: 'status', from: 'need_info', to: 'in_review',
        body: 'Автор предоставил уточнение — обращение возвращено на рассмотрение', at: now,
      });
    } else {
      db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(now, row.id);
    }
    const recipients = isAuthor || internal ? [row.assignee_id] : [row.author_id];
    notify(db, {
      userIds: recipients, ticketId: row.id, actorId: user.id, now,
      text: `${row.code}: новый комментарий`,
    });
  });
}

export function reassign(db, user, id, input, now) {
  if (!canReassign(user)) throw forbidden('Переназначать может только руководитель');
  const row = getTicketRow(db, id);
  const target = db
    .prepare("SELECT id, name FROM users WHERE id = ? AND role IN ('handler','manager','admin')")
    .get(Number(input.assigneeId));
  if (!target) throw badRequest('Выберите ответственного');
  const reason = text(input.reason, { field: 'Причина', max: 500 });
  inTransaction(db, () => {
    db.prepare('UPDATE tickets SET assignee_id = ?, updated_at = ? WHERE id = ?').run(target.id, now, row.id);
    addEvent(db, {
      ticketId: row.id, actorId: user.id, kind: 'assigned',
      body: `Ответственный: ${target.name}${reason ? `. ${reason}` : ''}`, at: now,
    });
    notify(db, {
      userIds: [target.id], ticketId: row.id, actorId: user.id, now,
      text: `Вам назначено обращение ${row.code}: ${row.title}`,
    });
  });
}

export function setPriority(db, user, id, input, now) {
  const row = getVisibleTicketRow(db, user, id);
  if (!canProcess(user, row)) throw forbidden();
  const priority = oneOf(input.priority, PRIORITIES, 'Приоритет');
  const sla = SLA_HOURS[priority];
  inTransaction(db, () => {
    db.prepare(
      'UPDATE tickets SET priority = ?, first_response_due = ?, due_at = ?, updated_at = ? WHERE id = ?',
    ).run(priority, addHours(row.created_at, sla.firstResponse), addHours(row.created_at, sla.resolve), now, row.id);
    addEvent(db, {
      ticketId: row.id, actorId: user.id, kind: 'priority',
      body: `Приоритет: ${PRIORITIES[row.priority]} → ${PRIORITIES[priority]}. Сроки SLA пересчитаны`, at: now,
    });
  });
}

// «Поддержать» — вместо дубликата сотрудник присоединяется к существующему обращению.
export function supportTicket(db, user, id, now) {
  const row = getTicketRow(db, id);
  if (row.author_id === user.id) throw badRequest('Нельзя поддержать собственное обращение');
  if (isFinal(row.status)) throw badRequest('Обращение уже рассмотрено');
  const { changes } = db
    .prepare('INSERT OR IGNORE INTO supports (ticket_id, user_id, created_at) VALUES (?, ?, ?)')
    .run(row.id, user.id, now);
  if (changes === 0) throw badRequest('Вы уже поддержали это обращение');
  addEvent(db, { ticketId: row.id, actorId: null, kind: 'support', body: 'Обращение поддержал ещё один сотрудник', at: now });
  return db.prepare('SELECT COUNT(*) AS n FROM supports WHERE ticket_id = ?').get(row.id).n;
}

export function markDuplicate(db, user, id, input, now) {
  const row = getVisibleTicketRow(db, user, id);
  if (!canProcess(user, row)) throw forbidden();
  if (isFinal(row.status)) throw badRequest('Обращение уже закрыто');
  const original = db.prepare('SELECT id, code, author_id FROM tickets WHERE code = ?').get(String(input.code || '').trim().toUpperCase());
  if (!original || original.id === row.id) throw badRequest('Укажите номер другого существующего обращения');
  const resolution = `Дубликат обращения ${original.code}. Автор добавлен в поддержавшие исходное обращение.`;
  inTransaction(db, () => {
    db.prepare(
      `UPDATE tickets SET status = 'closed', duplicate_of = ?, resolution = ?, resolved_at = ?, updated_at = ?,
         first_response_at = COALESCE(first_response_at, ?) WHERE id = ?`,
    ).run(original.id, resolution, now, now, now, row.id);
    if (original.author_id !== row.author_id) {
      db.prepare('INSERT OR IGNORE INTO supports (ticket_id, user_id, created_at) VALUES (?, ?, ?)').run(original.id, row.author_id, now);
    }
    addEvent(db, { ticketId: row.id, actorId: user.id, kind: 'status', from: row.status, to: 'closed', body: resolution, at: now });
    addEvent(db, { ticketId: original.id, actorId: null, kind: 'support', body: `Присоединено повторное обращение ${row.code}`, at: now });
    notify(db, {
      userIds: [row.author_id], ticketId: row.id, actorId: user.id, now,
      text: `${row.code} объединено с ${original.code} — вы будете получать уведомления по нему`,
    });
  });
}
