// Изменение обращений: создание, статусы, комментарии, назначение, поддержка, дубликаты.
import {
  TYPES, PRIORITIES, STATUSES, TRANSITIONS, LIMITS, addBusinessHours,
} from './config.js';
import { canView, canProcess, canReassign } from './access.js';
import { badRequest, forbidden, notFound } from './http.js';
import { inTransaction } from './db.js';
import { resolveAssignee } from './routing.js';
import { notify } from './notifications.js';
import { getTicketRow, getVisibleTicketRow, isFinal, isWatching, watcherIds } from './tickets-query.js';
import { getSla, getCalendarFor } from './settings.js';
import { validCounterpartyId } from './integrations/onec.js';

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

function validateNewTicket(db, input) {
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
    isPublic: input.isPublic === true,
    counterpartyId: validCounterpartyId(db, input.counterpartyId),
  };
}

export function createTicket(db, user, input, now) {
  const data = validateNewTicket(db, input);
  return inTransaction(db, () => {
    const code = nextCode(db);
    const sla = getSla(db)[data.priority];
    const assignment = resolveAssignee(db, data.categoryId, { excludeId: data.isAnonymous ? user.id : null });
    const holidays = getCalendarFor(db, assignment.userId);
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO tickets (code, type, category_id, title, description, proposed_solution, priority, status,
           author_id, is_anonymous, is_public, department, assignee_id, created_at, updated_at, first_response_due, due_at,
           counterparty_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        code, data.type, data.categoryId, data.title, data.description, data.proposedSolution, data.priority,
        user.id, data.isAnonymous ? 1 : 0, data.isPublic ? 1 : 0, user.department, assignment.userId, now, now,
        addBusinessHours(now, sla.firstResponse, holidays), addBusinessHours(now, sla.resolve, holidays),
        data.counterpartyId,
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
  // Прежний результат относится к прошлому итогу: при повторном открытии он снимается (остаётся в истории),
  // а новый итог требует нового результата. Переход «итог → закрыто» использует уже записанный.
  const reopening = isFinal(row.status) && !isFinal(target);
  const kept = reopening ? null : row.resolution;
  const resolution = isFinal(target) ? (resolutionInput || kept) : kept;
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
      body: [comment, isFinal(target) && resolutionInput && `Результат: ${resolutionInput}`].filter(Boolean).join('\n') || null,
      at: now,
    });
    // Рассмотренная идея возвращает голоса: записи удаляются, чтобы повторное открытие не вернуло их обратно.
    if (isFinal(target)) db.prepare('DELETE FROM idea_votes WHERE ticket_id = ?').run(row.id);
    // Повторное открытие: прежняя оценка автора относилась к старому итогу и больше не действует.
    if (isFinal(row.status) && !isFinal(target)) {
      const { changes } = db.prepare('DELETE FROM feedback WHERE ticket_id = ?').run(row.id);
      if (changes > 0) {
        addEvent(db, { ticketId: row.id, actorId: null, kind: 'feedback', body: 'Обращение открыто повторно — прежняя оценка автора сброшена', at: now });
      }
    }
    const followers = watcherIds(db, row.id);
    const recipients = isFinal(target)
      ? [row.author_id, ...supporterIds(db, row.id), ...followers]
      : [row.author_id, ...followers];
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
    // Внутренние заметки наблюдателям не уходят: они их не видят.
    const direct = isAuthor || internal ? [row.assignee_id] : [row.author_id, row.assignee_id];
    const recipients = internal ? direct : [...direct, ...watcherIds(db, row.id)];
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
    .prepare("SELECT id, name FROM users WHERE id = ? AND role IN ('handler','manager','admin') AND is_active = 1")
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
  const sla = getSla(db)[priority];
  const holidays = getCalendarFor(db, row.assignee_id);
  inTransaction(db, () => {
    db.prepare(
      'UPDATE tickets SET priority = ?, first_response_due = ?, due_at = ?, updated_at = ? WHERE id = ?',
    ).run(
      priority, addBusinessHours(row.created_at, sla.firstResponse, holidays),
      addBusinessHours(row.created_at, sla.resolve, holidays), now, row.id,
    );
    addEvent(db, {
      ticketId: row.id, actorId: user.id, kind: 'priority',
      body: `Приоритет: ${PRIORITIES[row.priority]} → ${PRIORITIES[priority]}. Сроки SLA пересчитаны`, at: now,
    });
  });
}

// «Поддержать» — вместо дубликата сотрудник присоединяется к существующему обращению.
export function supportTicket(db, user, id, now) {
  const row = getTicketRow(db, id);
  // Чужую закрытую проблему можно поддержать из «Похожих» не открывая; всё прочее, что пользователь не видит,
  // отвечает как несуществующее — перебором номеров не узнать тип и статус чужих обращений.
  if (!canView(user, row, isWatching(db, row.id, user.id)) && (row.type !== 'problem' || isFinal(row.status))) {
    throw notFound('Обращение не найдено');
  }
  // Для идей есть голосование, «у меня тоже» — только для проблем: два способа поддержки путали бы.
  if (row.type !== 'problem') throw badRequest('«У меня тоже» — для проблем. За идеи голосуют в «Идеях коллег»');
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
  const original = db.prepare('SELECT id, code, author_id, duplicate_of FROM tickets WHERE code = ?').get(String(input.code || '').trim().toUpperCase());
  if (!original || original.id === row.id) throw badRequest('Укажите номер другого существующего обращения');
  // Объединяем только с исходным: иначе A → B и затем B → A закрыли бы оба без живого обращения.
  if (original.duplicate_of) {
    const root = db.prepare('SELECT code FROM tickets WHERE id = ?').get(original.duplicate_of);
    throw badRequest(`${original.code} само объединено с ${root?.code ?? 'другим обращением'} — укажите исходное`);
  }
  const resolution = `Дубликат обращения ${original.code}. Автор добавлен в поддержавшие исходное обращение.`;
  inTransaction(db, () => {
    db.prepare(
      `UPDATE tickets SET status = 'closed', duplicate_of = ?, resolution = ?, resolved_at = ?, updated_at = ?,
         first_response_at = COALESCE(first_response_at, ?) WHERE id = ?`,
    ).run(original.id, resolution, now, now, now, row.id);
    // Как при любом закрытии: голоса за дубликат возвращаются сотрудникам.
    db.prepare('DELETE FROM idea_votes WHERE ticket_id = ?').run(row.id);
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

// Оценка результата автором: «решено / не решено» после итогового статуса (один раз).
export function rateTicket(db, user, id, input, now) {
  const row = getVisibleTicketRow(db, user, id);
  if (row.author_id !== user.id) throw forbidden('Оценить результат может только автор');
  if (!isFinal(row.status) || row.duplicate_of) throw badRequest('Оценка доступна после итогового решения');
  if (typeof input.isResolved !== 'boolean') throw badRequest('Укажите, решён ли вопрос');
  const comment = text(input.comment, { field: 'Комментарий', max: LIMITS.commentMax }) || null;
  if (db.prepare('SELECT 1 FROM feedback WHERE ticket_id = ?').get(row.id)) {
    throw badRequest('Оценка уже оставлена');
  }
  inTransaction(db, () => {
    db.prepare('INSERT INTO feedback (ticket_id, is_resolved, comment, created_at) VALUES (?, ?, ?, ?)')
      .run(row.id, input.isResolved ? 1 : 0, comment, now);
    const verdict = input.isResolved ? 'вопрос решён' : 'вопрос НЕ решён';
    addEvent(db, {
      ticketId: row.id, actorId: user.id, kind: 'feedback', at: now,
      body: `Оценка автора: ${verdict}${comment ? `\n${comment}` : ''}`,
    });
    notify(db, {
      userIds: [row.assignee_id], ticketId: row.id, actorId: user.id, now,
      text: `${row.code}: автор оценил результат — ${verdict}`,
    });
  });
}

// Публикацию в ленте идей можно включить и отменить: автор — своё решение, обработчик — если в переписке
// появилось то, что не предназначено всем сотрудникам.
// Автор исправляет текст, пока обращение не взяли в работу: «Новое» или «Ожидает уточнения».
// Позже текст не меняется, чтобы решение ответственного относилось к тому, что он прочитал.
const EDITABLE_STATUSES = Object.freeze(['new', 'need_info']);

export function editTicket(db, user, id, input, now) {
  const row = getVisibleTicketRow(db, user, id);
  if (row.author_id !== user.id) throw forbidden('Исправить обращение может только автор');
  if (!EDITABLE_STATUSES.includes(row.status)) throw badRequest('Обращение уже в работе — дополните его комментарием');
  const title = text(input.title, { field: 'Кратко', min: LIMITS.titleMin, max: LIMITS.titleMax, required: true });
  const description = text(input.description, { field: 'Описание', min: LIMITS.descriptionMin, max: LIMITS.descriptionMax, required: true });
  const solution = text(input.proposedSolution, { field: 'Предлагаемое решение', max: LIMITS.solutionMax }) || null;
  const changed = [title !== row.title && 'тема', description !== row.description && 'описание', solution !== row.proposed_solution && 'предлагаемое решение'].filter(Boolean);
  if (changed.length === 0) return;
  inTransaction(db, () => {
    db.prepare('UPDATE tickets SET title = ?, description = ?, proposed_solution = ?, updated_at = ? WHERE id = ?')
      .run(title, description, solution, now, row.id);
    addEvent(db, { ticketId: row.id, actorId: user.id, kind: 'edited', body: `Автор исправил: ${changed.join(', ')}`, at: now });
    notify(db, { userIds: [row.assignee_id], ticketId: row.id, actorId: user.id, now, text: `${row.code}: автор исправил обращение` });
  });
}

export function setPublic(db, user, id, input, now) {
  const row = getVisibleTicketRow(db, user, id);
  if (row.author_id !== user.id && !canProcess(user, row)) throw forbidden('Публикацией управляют автор и ответственный');
  if (typeof input.isPublic !== 'boolean') throw badRequest('Ожидается isPublic: true/false');
  if (Boolean(row.is_public) === input.isPublic) return;
  inTransaction(db, () => {
    db.prepare('UPDATE tickets SET is_public = ?, updated_at = ? WHERE id = ?').run(input.isPublic ? 1 : 0, now, row.id);
    // Снятая с ленты идея возвращает голоса тем, кто за неё голосовал.
    if (!input.isPublic) db.prepare('DELETE FROM idea_votes WHERE ticket_id = ?').run(row.id);
    addEvent(db, {
      ticketId: row.id, actorId: user.id, kind: 'publish', at: now,
      body: input.isPublic ? 'Обращение показано в «Идеях коллег»' : 'Обращение убрано из «Идей коллег»',
    });
  });
}
