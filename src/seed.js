// Заполнение пустой БД демонстрационными данными из датасета с правдоподобной историей.
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { SLA_HOURS, addHours, addBusinessHours } from './config.js';
import { inTransaction } from './db.js';
import { addEvent } from './tickets-actions.js';
import { notify } from './notifications.js';
import { USERS, CATEGORIES, TICKETS } from './seed-data.js';

const ACCEPTED = 'Обращение принято к рассмотрению.';

// Шаги истории для каждого исходного статуса: [статус, час после создания, текст, результат?]
function timeline(ticket, firstResponseH) {
  const r = firstResponseH;
  const half = Math.round(ticket.ageHours * 0.6);
  switch (ticket.status) {
    case 'in_review':
      return [['in_review', r, `${ACCEPTED} План: ${ticket.action}`]];
    case 'need_info':
      return [['need_info', r, ticket.action]];
    case 'in_progress':
      return [['in_review', r, ACCEPTED], ['in_progress', r * 2, `Взято в работу. План: ${ticket.action}`]];
    case 'implemented':
      return [['in_review', r, ACCEPTED], ['in_progress', r * 2, 'Взято в работу'], ['implemented', half, null, ticket.action]];
    case 'rejected':
      return [['in_review', r, ACCEPTED], ['rejected', r * 2, null, ticket.action]];
    case 'closed':
      return [['closed', r, null, ticket.action]];
    default:
      return [];
  }
}

function insertTicket(db, ticket, index, ids, nowMs) {
  const created = new Date(nowMs - ticket.ageHours * 3600_000).toISOString();
  const at = (h) => addHours(created, h);
  const firstResponseH = Math.min(4 + ((index * 7) % 20), Math.max(1, Math.floor(ticket.ageHours / 4)));
  const steps = timeline(ticket, firstResponseH);
  const last = steps.at(-1);
  const resolution = last?.[3] ?? null;
  const sla = SLA_HOURS[ticket.priority];
  const id = index + 1;
  const authorId = ids.users.get(ticket.author);
  const assigneeId = ids.users.get(ticket.assignee);
  const author = USERS.find(([name]) => name === ticket.author);

  db.prepare(
    `INSERT INTO tickets (id, code, type, category_id, title, description, priority, status, author_id, department,
       assignee_id, resolution, created_at, updated_at, first_response_due, due_at, first_response_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, ticket.code, ticket.type, ids.categories.get(ticket.category), ticket.title, ticket.description,
    ticket.priority, ticket.status, authorId, author[2], assigneeId, resolution, created,
    last ? at(last[1]) : created, addBusinessHours(created, sla.firstResponse), addBusinessHours(created, sla.resolve),
    steps.length ? at(steps[0][1]) : null,
    resolution ? at(last[1]) : null,
  );

  addEvent(db, { ticketId: id, actorId: authorId, kind: 'created', to: 'new', at: created });
  addEvent(db, { ticketId: id, actorId: null, kind: 'assigned', body: 'Назначен по правилу категории', at: created });
  let prev = 'new';
  for (const [to, h, body, res] of steps) {
    const text = [body, res && `Результат: ${res}`].filter(Boolean).join('\n');
    addEvent(db, { ticketId: id, actorId: assigneeId, kind: 'status', from: prev, to, body: text, at: at(h) });
    prev = to;
  }
  for (const [i, name] of ticket.supporters.entries()) {
    db.prepare('INSERT INTO supports (ticket_id, user_id, created_at) VALUES (?, ?, ?)')
      .run(id, ids.users.get(name), at(1 + i));
    addEvent(db, { ticketId: id, actorId: null, kind: 'support', body: 'Обращение поддержал ещё один сотрудник', at: at(1 + i) });
  }
  if (ticket.status === 'new') {
    notify(db, {
      userIds: [assigneeId], ticketId: id, actorId: authorId, now: created,
      text: `Вам назначено обращение ${ticket.code}: ${ticket.title}`,
    });
  }
  return { id, at, assigneeId };
}

// Два демонстрационных опроса: завершённый с ответами пяти сотрудников (результаты доступны) и открытый.
function seedSurvey(db, users, nowIso) {
  const created = addHours(nowIso, -240);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO surveys (title, description, created_by, created_at) VALUES (?, ?, ?, ?)')
    .run('Удобство внутренних процессов', 'Короткий опрос: что помогает работать, а что мешает. Ответы показываются только сводно.',
      users.get('Директор по развитию'), created);
  const surveyId = Number(lastInsertRowid);
  const questions = [
    ['Насколько понятно, к кому обращаться с рабочим вопросом?', 'scale', [4, 3, 5, 3, 4]],
    ['Насколько быстро смежные подразделения отвечают на запросы?', 'scale', [3, 2, 4, 3, 2]],
    ['Что стоит изменить в первую очередь?', 'text', [
      'Единое место для статусов по документам.', 'Понятные сроки ответа от смежных отделов.', '',
      'Шаблон постановки задачи с результатом и сроком.', 'Актуальные инструкции в одном месте.',
    ]],
  ];
  const respondents = ['Сотрудник закупок', 'Сотрудник бухгалтерии', 'Менеджер по продажам', 'Координатор проекта', 'Сотрудник проектирования'];
  questions.forEach(([text, kind, answers], position) => {
    const q = db.prepare('INSERT INTO survey_questions (survey_id, text, kind, position) VALUES (?, ?, ?, ?)').run(surveyId, text, kind, position);
    respondents.forEach((name, i) => {
      db.prepare('INSERT INTO survey_answers (question_id, user_id, value, created_at) VALUES (?, ?, ?, ?)')
        .run(Number(q.lastInsertRowid), users.get(name), String(answers[i]), addHours(created, 5 + i * 7));
    });
  });
  db.prepare('UPDATE surveys SET is_open = 0 WHERE id = ?').run(surveyId);

  const open = db
    .prepare('INSERT INTO surveys (title, description, created_by, created_at) VALUES (?, ?, ?, ?)')
    .run('Как вам новая система обратной связи?', 'Два вопроса, одна минута. Результаты подведём после закрытия опроса.',
      users.get('Директор по развитию'), addHours(nowIso, -20));
  const openId = Number(open.lastInsertRowid);
  const insert = db.prepare('INSERT INTO survey_questions (survey_id, text, kind, position) VALUES (?, ?, ?, ?)');
  insert.run(openId, 'Насколько удобно подавать обращения?', 'scale', 0);
  insert.run(openId, 'Чего не хватает?', 'text', 1);
}

// Голоса за идеи из ленты (у каждого не больше 5, на идею — не больше 3, за свою — нельзя).
function seedVotes(db, users, nowIso) {
  const votes = [
    ['Сотрудник офиса', 'A-020', 3], ['Сотрудник офиса', 'A-012', 2],
    ['Сотрудник бухгалтерии', 'A-020', 2], ['Сотрудник бухгалтерии', 'A-014', 3],
    ['Менеджер по продажам', 'A-014', 2], ['Менеджер по продажам', 'A-002', 1],
    ['Сотрудник проектирования', 'A-010', 3],
  ];
  const insert = db.prepare('INSERT INTO idea_votes (ticket_id, user_id, count, created_at) SELECT id, ?, ?, ? FROM tickets WHERE code = ?');
  votes.forEach(([name, code, count], i) => insert.run(users.get(name), count, addHours(nowIso, -30 + i), code));
}

// Вымышленные отзывы клиентов для демонстрации расчёта NPS.
function seedClientFeedback(db, nowIso) {
  const rows = [
    ['Условный клиент А', 'ООО «Пример-Строй»', 10, 'Проект сдали в срок, инженеры всегда на связи.', 200],
    ['Условный клиент Б', 'АО «Объект-Сервис»', 9, 'Понравилась пусконаладка: быстро и аккуратно.', 130],
    ['Условный клиент В', null, 7, 'Оборудование хорошее, но спецификацию согласовывали дольше, чем ожидали.', 60],
    ['Условный клиент Г', 'ИП «Пример»', 4, 'Долго ждали ответа по гарантийному обращению.', 20],
  ];
  const insert = db.prepare('INSERT INTO client_feedback (name, company, score, message, created_at) VALUES (?, ?, ?, ?, ?)');
  for (const [name, company, score, message, hoursAgo] of rows) insert.run(name, company, score, message, addHours(nowIso, -hoursAgo));
}

// Демонстрационные вложения, чтобы раздел «Материалы» в карточках не был пустым. Содержимое вымышленное.
const SAMPLE_FILES = [
  ['A-001', 'author', 'пример_заявки_на_закупку.csv', 2,
    'Позиция;Назначение;Требуемые параметры;Количество\nНасос циркуляционный;Система отопления корпуса Б;Расход 6 м3/ч, напор 8 м;2\nКлапан балансировочный;Стояк 3;DN25, PN16;4\n'],
  ['A-003', 'assignee', 'расхождения_обозначений.csv', 40,
    'Обозначение в спецификации;Обозначение в каталоге;Комментарий\nНасос ЦН-25/6;ЦН 25-6;одна позиция, разное написание\nКлапан КБ-25;КБ25-16;нужна проверка карточки\n'],
  ['A-005', 'author', 'этапы_согласования_документов.txt', 30,
    'Этапы, где возникают вопросы:\n1. Передача пакета от проекта в бухгалтерию — не видно, кто принял.\n2. Подписание у руководителя направления — неизвестен срок.\n3. Возврат на исправление — непонятно, на каком этапе пакет.\n'],
];

function seedAttachments(db, uploadsDir, inserted) {
  mkdirSync(uploadsDir, { recursive: true });
  const insert = db.prepare(
    'INSERT INTO attachments (ticket_id, uploader_id, original_name, stored_name, size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const [code, who, name, hour, content] of SAMPLE_FILES) {
    const ticket = inserted[TICKETS.findIndex((t) => t.code === code)];
    const { author_id: authorId } = db.prepare('SELECT author_id FROM tickets WHERE id = ?').get(ticket.id);
    const uploaderId = who === 'author' ? authorId : ticket.assigneeId;
    const buffer = Buffer.from(content, 'utf8');
    const storedName = `${randomBytes(16).toString('hex')}${extname(name)}`;
    writeFileSync(join(uploadsDir, storedName), buffer);
    insert.run(ticket.id, uploaderId, name, storedName, buffer.length, ticket.at(hour));
    addEvent(db, { ticketId: ticket.id, actorId: uploaderId, kind: 'attachment', body: `Прикреплён файл: ${name}`, at: ticket.at(hour) });
  }
}

// Рабочий запуск без демо-данных (DEMO_DATA=0): в пустой базе создаётся один администратор,
// который загружает оргструктуру из Битрикс24 (или импортирует CSV) и настраивает категории.
// b24Id (ADMIN_B24_ID) — его ID в Битрикс24: когда вход только через портал, без него администратор не войдёт.
// Если вход через Битрикс24 включили позже, ID связывается с первым ещё не связанным администратором.
export function bootstrapAdmin(db, name = 'Администратор системы', b24Id = null) {
  const id = b24Id === null || b24Id === undefined || b24Id === '' ? null : Number(b24Id);
  if (id !== null && !(Number.isInteger(id) && id > 0)) throw new Error('ADMIN_B24_ID: нужен числовой ID пользователя Битрикс24');
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n === 0) {
    db.prepare("INSERT INTO users (name, role, department, b24_id) VALUES (?, 'admin', 'IT', ?)")
      .run(String(name).trim().slice(0, 80) || 'Администратор системы', id);
    return true;
  }
  if (id !== null && !db.prepare('SELECT 1 FROM users WHERE b24_id = ?').get(id)) {
    db.prepare(`UPDATE users SET b24_id = ? WHERE id = (
      SELECT id FROM users WHERE role = 'admin' AND is_active = 1 AND b24_id IS NULL ORDER BY id LIMIT 1)`).run(id);
  }
  return false;
}

// uploadsDir не обязателен: без него база заполняется без демонстрационных файлов.
export function seedIfEmpty(db, nowIso, uploadsDir = null) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n > 0) return false;
  const nowMs = new Date(nowIso).getTime();
  inTransaction(db, () => {
    const users = new Map();
    for (const [name, role, department] of USERS) {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO users (name, role, department) VALUES (?, ?, ?)')
        .run(name, role, department);
      users.set(name, Number(lastInsertRowid));
    }
    const categories = new Map();
    for (const [name, assignee, fallback] of CATEGORIES) {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO categories (name, assignee_id, fallback_id) VALUES (?, ?, ?)')
        .run(name, users.get(assignee), fallback ? users.get(fallback) : null);
      categories.set(name, Number(lastInsertRowid));
    }
    const ids = { users, categories };
    const inserted = TICKETS.map((ticket, index) => insertTicket(db, ticket, index, ids, nowMs));

    // Внутренняя заметка — видна только обработчикам (демонстрация разграничения доступа).
    const a003 = inserted[2];
    addEvent(db, {
      ticketId: a003.id, actorId: a003.assigneeId, kind: 'comment', internal: true, at: a003.at(30),
      body: 'Внутренняя заметка: согласовать с IT выгрузку справочника номенклатуры для проверки дублей.',
    });

    // Предложения опубликованы в ленте идей; проблемы и отзыв остаются закрытыми для посторонних.
    db.exec("UPDATE tickets SET is_public = 1 WHERE type = 'idea'");
    seedVotes(db, users, nowIso);
    seedSurvey(db, users, nowIso);
    seedClientFeedback(db, nowIso);
    if (uploadsDir) seedAttachments(db, uploadsDir, inserted);
  });
  return true;
}
