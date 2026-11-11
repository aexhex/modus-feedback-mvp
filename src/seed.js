// Заполнение пустой БД демонстрационными данными из датасета с правдоподобной историей.
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

export function seedIfEmpty(db, nowIso) {
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
    seedSurvey(db, users, nowIso);
    seedClientFeedback(db, nowIso);
  });
  return true;
}
