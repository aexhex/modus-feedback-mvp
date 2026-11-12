import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { seedTemplates } from '../src/templates.js';

const categoryId = (app, name) => app.db.prepare('SELECT id FROM categories WHERE name = ?').get(name).id;
const hoursBetween = (from, to) => (new Date(to) - new Date(from)) / 3600_000;
const file = { name: 'note.txt', dataBase64: Buffer.from('текст').toString('base64') };

describe('лента идей', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('опубликованные предложения видят все сотрудники', async () => {
    const emp = await app.as('Сотрудник офиса');
    const feed = (await emp.get('/api/tickets?scope=feed&limit=50')).json;
    assert.equal(feed.meta.total, 10);
    assert.ok(feed.data.every((t) => t.type === 'idea' && t.isPublic));
    const open = await emp.get(`/api/tickets/${app.ticketId('A-002')}`);
    assert.equal(open.status, 200);
    assert.equal(open.json.data.permissions.canProcess, false);
    assert.equal(open.json.data.permissions.canAttach, false);
  });

  it('читатель может комментировать, но не обрабатывать и не прикладывать файлы', async () => {
    const id = app.ticketId('A-002');
    const emp = await app.as('Сотрудник офиса');
    assert.equal((await emp.post(`/api/tickets/${id}/comments`, { body: 'Поддерживаю, нам тоже нужно' })).status, 200);
    assert.equal((await emp.post(`/api/tickets/${id}/status`, { status: 'in_progress' })).status, 403);
    assert.equal((await emp.post(`/api/tickets/${id}/attachments`, file)).status, 403);
    assert.equal((await emp.post(`/api/tickets/${id}/comments`, { body: 'x', internal: true })).status, 403);
  });

  it('подписка на опубликованное обращение не даёт права прикладывать файлы', async () => {
    const id = app.ticketId('A-006');
    const emp = await app.as('Сотрудник офиса');
    assert.equal((await emp.post(`/api/tickets/${id}/watch`, { watch: true })).status, 200);
    assert.equal((await emp.post(`/api/tickets/${id}/attachments`, file)).status, 403);
  });

  it('автор и ответственный могут убрать обращение из ленты, читатель — нет', async () => {
    const id = app.ticketId('A-010');
    const reader = await app.as('Сотрудник офиса');
    assert.equal((await reader.post(`/api/tickets/${id}/publish`, { isPublic: false })).status, 403);
    const author = await app.as('Менеджер по продажам');
    assert.equal((await author.get(`/api/tickets/${id}`)).json.data.permissions.canPublish, true);
    const hidden = await author.post(`/api/tickets/${id}/publish`, { isPublic: false });
    assert.equal(hidden.json.data.isPublic, false);
    assert.equal((await reader.get(`/api/tickets/${id}`)).status, 404);
    const handler = await app.as('Руководитель продаж');
    assert.equal((await handler.post(`/api/tickets/${id}/publish`, { isPublic: true })).json.data.isPublic, true);
    assert.equal((await handler.post(`/api/tickets/${id}/publish`, {})).status, 400);
    assert.equal((await reader.get(`/api/tickets/${id}`)).status, 200);
  });

  it('похожее опубликованное обращение можно открыть из подсказки', async () => {
    const emp = await app.as('Сотрудник офиса');
    const text = encodeURIComponent('пошаговая памятка для операций между подразделениями');
    const found = (await emp.get(`/api/tickets/similar?text=${text}`)).json.data.find((s) => s.code === 'A-006');
    assert.equal(found.canOpen, true);
  });

  it('неопубликованные обращения по-прежнему закрыты для посторонних', async () => {
    const emp = await app.as('Сотрудник офиса');
    assert.equal((await emp.get(`/api/tickets/${app.ticketId('A-001')}`)).status, 404);
    const mine = (await emp.get('/api/tickets')).json.data;
    assert.ok(mine.every((t) => t.author?.name === 'Сотрудник офиса'));
  });

  it('автор сам решает, публиковать ли обращение; анонимность в ленте сохраняется', async () => {
    const author = await app.as('Сотрудник бухгалтерии');
    const base = { type: 'idea', categoryId: categoryId(app, 'Обучение'), description: 'Описание идеи для проверки ленты.' };
    const hidden = (await author.post('/api/tickets', { ...base, title: 'Закрытая идея' })).json.data;
    const shown = (await author.post('/api/tickets', { ...base, title: 'Открытая анонимная идея', isPublic: true, isAnonymous: true })).json.data;
    const reader = await app.as('Сотрудник офиса');
    assert.equal((await reader.get(`/api/tickets/${hidden.id}`)).status, 404);
    const seen = (await reader.get(`/api/tickets/${shown.id}`)).json.data;
    assert.equal(seen.author, null);
    assert.equal(seen.department, null);
  });
});

describe('отчёт о внедрении и признание авторов', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('ответственный публикует отчёт по реализованному обращению', async () => {
    const id = app.ticketId('A-004');
    const handler = await app.as('Ответственный за обучение');
    const saved = await handler.post(`/api/tickets/${id}/report`, { done: 'Провели два семинара по новым линейкам.', effect: 'Уточняющих вопросов от закупок стало вдвое меньше.' });
    assert.equal(saved.status, 200);
    assert.match(saved.json.data.report.effect, /вдвое меньше/);
    const author = await app.as('Сотрудник закупок');
    const notes = (await author.get('/api/notifications')).json.data.items.map((n) => n.text);
    assert.ok(notes.some((t) => /A-004: опубликован отчёт о внедрении/.test(t)));
    const board = (await author.get('/api/board')).json.data;
    assert.match(board.implemented.find((w) => w.code === 'A-004').reportDone, /семинара/);
  });

  it('отчёт недоступен для нереализованных обращений и для автора', async () => {
    const handler = await app.as('Руководитель закупок');
    const early = await handler.post(`/api/tickets/${app.ticketId('A-001')}/report`, { done: 'Сделано много', effect: 'Эффект есть' });
    assert.equal(early.status, 400);
    const author = await app.as('Сотрудник закупок');
    const own = await author.post(`/api/tickets/${app.ticketId('A-004')}/report`, { done: 'Сделано много', effect: 'Эффект есть' });
    assert.equal(own.status, 403);
    const owner = await app.as('Ответственный за обучение');
    assert.equal((await owner.post(`/api/tickets/${app.ticketId('A-004')}/report`, { done: 'да', effect: 'нет' })).status, 400);
  });

  it('доска показывает авторов принятых идей, главная — личный счётчик', async () => {
    const emp = await app.as('Сотрудник закупок');
    const board = (await emp.get('/api/board')).json.data;
    assert.deepEqual(board.topAuthors.map((a) => [a.name, a.count]), [['Сотрудник бухгалтерии', 1], ['Сотрудник закупок', 1]]);
    assert.equal(board.authorOfMonth.name, 'Сотрудник бухгалтерии');
    // Обращение, убранное из ленты, в рейтинге авторов не участвует.
    app.db.prepare("UPDATE tickets SET is_public = 0 WHERE code = 'A-008'").run();
    const after = (await emp.get('/api/board')).json.data;
    assert.deepEqual(after.topAuthors.map((a) => a.name), ['Сотрудник закупок']);
    assert.equal((await emp.get('/api/home')).json.data.author.implementedCount, 1);
  });
});

describe('аналитика: нагрузка, время в статусе, отчёт за период', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('нагрузка по ответственным и время в статусах', async () => {
    const manager = await app.as('Директор по развитию');
    const a = (await manager.get('/api/analytics')).json.data;
    assert.deepEqual(a.workload.find((w) => w.name === 'IT-специалист'), { name: 'IT-специалист', open: 2, waiting: 1, overdue: 1 });
    assert.equal(a.workload.reduce((sum, w) => sum + w.open, 0), 16);
    const inReview = a.timeInStatus.find((s) => s.key === 'in_review');
    assert.ok(inReview.avgHours > 0 && inReview.count > 0);
    assert.ok(!a.timeInStatus.some((s) => s.key === 'closed'));
  });

  it('отчёт за последние 30 дней по умолчанию', async () => {
    const manager = await app.as('Директор по развитию');
    const r = (await manager.get('/api/report')).json.data;
    assert.equal(r.from, '2026-10-13');
    assert.equal(r.to, '2026-11-11');
    assert.equal(r.totals.created, 18);
    assert.equal(r.totals.implemented, 2);
    assert.equal(r.totals.rejected, 1);
    assert.equal(r.totals.overdueNow, 4);
    assert.deepEqual(r.implemented.map((t) => t.code).sort(), ['A-004', 'A-008']);
    assert.equal(r.topSupported[0].code, 'A-003');
  });

  it('закрытие реализованного обращения не убирает его из отчёта', async () => {
    const handler = await app.as('Ответственный за обучение');
    assert.equal((await handler.post(`/api/tickets/${app.ticketId('A-004')}/status`, { status: 'closed' })).status, 200);
    const manager = await app.as('Директор по развитию');
    const r = (await manager.get('/api/report')).json.data;
    assert.equal(r.totals.implemented, 2);
    assert.deepEqual(r.implemented.map((t) => t.code).sort(), ['A-004', 'A-008']);
    assert.equal(r.totals.rejected, 1);
  });

  it('произвольный период и проверка параметров', async () => {
    const manager = await app.as('Директор по развитию');
    const week = (await manager.get('/api/report?from=2026-11-05&to=2026-11-11')).json.data;
    assert.equal(week.from, '2026-11-05');
    assert.ok(week.totals.created < 18 && week.totals.created > 0);
    assert.equal((await manager.get('/api/report?from=11.05.2026')).status, 400);
    assert.equal((await manager.get('/api/report?from=2026-11-11&to=2026-11-01')).status, 400);
    assert.equal((await manager.get('/api/report?from=2020-01-01&to=2026-11-11')).status, 400);
    const emp = await app.as('Сотрудник офиса');
    assert.equal((await emp.get('/api/report')).status, 403);
  });
});

describe('администрирование: шаблоны, праздники, пользователи, журнал', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('шаблоны ответов редактируются и попадают в справочник', async () => {
    const admin = await app.as('Администратор системы');
    assert.equal((await admin.get('/api/admin/templates')).json.data.length, 6);
    const created = await admin.post('/api/admin/templates', { title: 'Передано в ИТ', field: 'comment', text: 'Передали вопрос в ИТ-отдел, вернёмся с ответом.' });
    assert.equal(created.status, 201);
    const id = created.json.data.find((t) => t.title === 'Передано в ИТ').id;
    await admin.patch(`/api/admin/templates/${id}`, { title: 'Передано в ИТ-отдел', field: 'comment', text: 'Передали вопрос в ИТ-отдел.' });
    const emp = await app.as('Сотрудник офиса');
    assert.ok((await emp.get('/api/meta')).json.data.templates.some((t) => t.title === 'Передано в ИТ-отдел'));
    assert.equal((await admin.del(`/api/admin/templates/${id}`)).json.data.length, 6);
    assert.equal((await admin.post('/api/admin/templates', { title: 'Плохой', field: 'html', text: 'Некорректное поле' })).status, 400);
    assert.equal((await admin.del('/api/admin/templates/99999')).status, 404);
    assert.equal((await emp.get('/api/admin/templates')).status, 403);
  });

  it('удалённые шаблоны не возвращаются после перезапуска', async () => {
    const admin = await app.as('Администратор системы');
    for (const t of (await admin.get('/api/admin/templates')).json.data) await admin.del(`/api/admin/templates/${t.id}`);
    assert.equal((await admin.get('/api/admin/templates')).json.data.length, 0);
    seedTemplates(app.db);
    assert.equal((await admin.get('/api/admin/templates')).json.data.length, 0);
  });

  it('новый праздник сдвигает срок нового обращения', async () => {
    const admin = await app.as('Администратор системы');
    assert.ok((await admin.get('/api/admin/holidays')).json.data.includes('2026-11-04'));
    assert.equal((await admin.patch('/api/admin/holidays', { dates: ['2026-13-40'] })).status, 400);
    assert.equal((await admin.patch('/api/admin/holidays', { dates: 'завтра' })).status, 400);
    const saved = await admin.patch('/api/admin/holidays', { dates: ['2026-11-12', '2026-11-12', ' 2026-12-31 '] });
    assert.deepEqual(saved.json.data, ['2026-11-12', '2026-12-31']);
    const emp = await app.as('Сотрудник офиса');
    const t = (await emp.post('/api/tickets', {
      type: 'problem', categoryId: categoryId(app, 'Обучение'), title: 'Срок через праздник', description: 'Проверка пропуска праздничного дня.', priority: 'high',
    })).json.data;
    // Среда 12:00 + 1 рабочий день: четверг 12.11 объявлен праздником, срок — пятница 12:00
    assert.equal(hoursBetween(t.createdAt, t.firstResponseDue), 48);
  });

  it('пользователи: создание, вход, отключение', async () => {
    const admin = await app.as('Администратор системы');
    const created = await admin.post('/api/admin/users', { name: 'Инженер сервиса', role: 'handler', department: 'Сервис' });
    assert.equal(created.status, 201);
    const user = created.json.data.find((u) => u.name === 'Инженер сервиса');
    assert.equal((await admin.post('/api/admin/users', { name: 'Инженер сервиса', role: 'handler', department: 'Сервис' })).status, 400);
    assert.equal((await admin.post('/api/admin/users', { name: 'Кто-то', role: 'root', department: 'Сервис' })).status, 400);

    const engineer = await app.as('Инженер сервиса');
    assert.equal((await engineer.get('/api/me')).json.data.role, 'handler');
    await admin.patch(`/api/admin/users/${user.id}`, { isActive: false });
    assert.equal((await engineer.get('/api/me')).status, 401);
    const publicList = (await app.request(null, 'GET', '/api/demo-users')).json.data.users;
    assert.ok(!publicList.some((u) => u.name === 'Инженер сервиса'));
    assert.equal((await app.request(null, 'POST', '/api/session', { userId: user.id })).status, 404);
    assert.ok((await admin.get('/api/admin/users')).json.data.some((u) => u.name === 'Инженер сервиса' && !u.isActive));
  });

  it('отключённому пользователю нельзя назначить обращение', async () => {
    const admin = await app.as('Администратор системы');
    const created = await admin.post('/api/admin/users', { name: 'Временный обработчик', role: 'handler', department: 'Сервис' });
    const temp = created.json.data.find((u) => u.name === 'Временный обработчик');
    await admin.patch(`/api/admin/users/${temp.id}`, { isActive: false });
    const manager = await app.as('Директор по развитию');
    const id = app.ticketId('A-001');
    assert.equal((await manager.post(`/api/tickets/${id}/assign`, { assigneeId: temp.id })).status, 400);
    assert.equal((await manager.post(`/api/tickets/${id}/invite`, { userId: temp.id })).status, 400);
  });

  it('пользователи: защитные ограничения', async () => {
    const admin = await app.as('Администратор системы');
    const self = app.userId('Администратор системы');
    assert.equal((await admin.patch(`/api/admin/users/${self}`, { role: 'employee' })).status, 400);
    assert.equal((await admin.patch(`/api/admin/users/${self}`, { isActive: false })).status, 400);
    const routed = await admin.patch(`/api/admin/users/${app.userId('IT-специалист')}`, { role: 'employee' });
    assert.equal(routed.status, 400);
    assert.match(routed.json.error, /правил маршрутизации/);
    const renamed = await admin.patch(`/api/admin/users/${app.userId('Сотрудник офиса')}`, { department: 'Офис', role: 'handler' });
    assert.equal(renamed.status, 200);
    assert.equal((await admin.patch(`/api/admin/users/${app.userId('Сотрудник офиса')}`, { name: 'IT-специалист' })).status, 400);
    assert.equal((await admin.patch('/api/admin/users/99999', { department: 'Офис' })).status, 404);
  });

  it('журнал действий фиксирует изменения и закрыт для остальных', async () => {
    const admin = await app.as('Администратор системы');
    const actions = (await admin.get('/api/admin/audit')).json.data;
    assert.ok(actions.some((a) => a.action === 'Пользователь создан' && /Инженер сервиса/.test(a.details)));
    assert.ok(actions.some((a) => a.action === 'Список праздников изменён'));
    assert.ok(actions.some((a) => a.action === 'Шаблон ответа удалён'));
    assert.ok(actions.every((a) => a.actorName === 'Администратор системы'));
    const manager = await app.as('Директор по развитию');
    assert.equal((await manager.get('/api/admin/audit')).status, 403);
  });
});

describe('опросы сотрудников', () => {
  let app;
  let surveyId;
  const CLOSED = 'Удобство внутренних процессов';
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('сотрудник видит только открытый опрос, руководитель — и завершённый', async () => {
    const emp = await app.as('Сотрудник офиса');
    const list = (await emp.get('/api/surveys')).json.data;
    assert.deepEqual(list.map((s) => s.title), ['Как вам новая система обратной связи?']);
    assert.equal(list[0].answered, false);
    assert.equal(list[0].respondents, undefined);
    assert.equal((await emp.get('/api/home')).json.data.surveysOpen, 1);
    const manager = await app.as('Директор по развитию');
    const all = (await manager.get('/api/surveys')).json.data;
    assert.equal(all.find((s) => s.title === CLOSED).respondents, 5);
  });

  it('руководитель создаёт опрос, сотрудник — нет', async () => {
    const manager = await app.as('Директор по развитию');
    const created = await manager.post('/api/surveys', {
      title: 'Оценка обучения', scaleQuestions: ['Насколько полезны семинары?'], textQuestions: ['Какой темы не хватает?'],
    });
    assert.equal(created.status, 201);
    surveyId = created.json.data.id;
    assert.equal((await manager.post('/api/surveys', { title: 'Пустой опрос' })).status, 400);
    const emp = await app.as('Сотрудник офиса');
    assert.equal((await emp.post('/api/surveys', { title: 'Мой опрос', scaleQuestions: ['Вопрос?'] })).status, 403);
  });

  it('прохождение: обязательная оценка, один раз на человека', async () => {
    const emp = await app.as('Сотрудник офиса');
    const survey = (await emp.get(`/api/surveys/${surveyId}`)).json.data;
    const [scale, text] = survey.questions;
    assert.equal((await emp.post(`/api/surveys/${surveyId}/answers`, { answers: { [text.id]: 'Пусконаладка' } })).status, 400);
    assert.equal((await emp.post(`/api/surveys/${surveyId}/answers`, { answers: { [scale.id]: 9 } })).status, 400);
    const ok = await emp.post(`/api/surveys/${surveyId}/answers`, { answers: { [scale.id]: 5, [text.id]: 'Пусконаладка' } });
    assert.equal(ok.status, 200);
    assert.equal((await emp.post(`/api/surveys/${surveyId}/answers`, { answers: { [scale.id]: 4 } })).status, 400);
    assert.equal((await emp.get(`/api/surveys/${surveyId}`)).json.data.answered, true);
    assert.equal((await emp.get('/api/home')).json.data.surveysOpen, 1);
  });

  it('пока опрос открыт, результаты скрыты даже от руководителя', async () => {
    const manager = await app.as('Директор по развитию');
    const open = (await manager.get(`/api/surveys/${surveyId}/results`)).json.data;
    assert.equal(open.hidden, true);
    assert.equal(open.reason, 'open');
    assert.deepEqual(open.questions, []);
    const emp = await app.as('Сотрудник офиса');
    assert.equal((await emp.get(`/api/surveys/${surveyId}/results`)).status, 403);
  });

  it('после закрытия: порог анонимности, повторно открыть нельзя', async () => {
    const manager = await app.as('Директор по развитию');
    assert.equal((await manager.patch(`/api/surveys/${surveyId}`, { isOpen: false })).status, 200);
    const few = (await manager.get(`/api/surveys/${surveyId}/results`)).json.data;
    assert.equal(few.hidden, true);
    assert.equal(few.reason, 'few');
    assert.equal(few.respondents, 1);
    const reopen = await manager.patch(`/api/surveys/${surveyId}`, { isOpen: true });
    assert.equal(reopen.status, 400);
    assert.match(reopen.json.error, /нельзя открыть заново/);

    const emp = await app.as('Сотрудник бухгалтерии');
    assert.ok(!(await emp.get('/api/surveys')).json.data.some((s) => s.id === surveyId));
    assert.equal((await emp.get(`/api/surveys/${surveyId}`)).status, 404);
    assert.equal((await emp.post(`/api/surveys/${surveyId}/answers`, { answers: {} })).status, 400);
    assert.equal((await emp.patch(`/api/surveys/${surveyId}`, { isOpen: true })).status, 403);
    assert.equal((await manager.get('/api/surveys/99999')).status, 404);
  });

  it('завершённый опрос с достаточным числом ответов показывает сводные результаты', async () => {
    const manager = await app.as('Директор по развитию');
    const closed = (await manager.get('/api/surveys')).json.data.find((s) => s.title === CLOSED);
    const full = (await manager.get(`/api/surveys/${closed.id}/results`)).json.data;
    assert.equal(full.hidden, false);
    assert.equal(full.respondents, 5);
    assert.equal(full.questions[0].average, 3.8);
    assert.equal(full.questions[0].distribution.find((d) => d.value === 3).count, 2);
    assert.equal(full.questions[2].answers.length, 4);
    assert.equal(full.questions[2].answersHidden, false);
  });

  it('тексты скрыты, если непустых ответов меньше порога', async () => {
    const closed = app.db.prepare('SELECT id FROM surveys WHERE title = ?').get(CLOSED);
    const textQuestion = app.db.prepare("SELECT id FROM survey_questions WHERE survey_id = ? AND kind = 'text'").get(closed.id);
    app.db.prepare("UPDATE survey_answers SET value = '' WHERE question_id = ? AND user_id NOT IN (SELECT id FROM users WHERE name IN ('Сотрудник закупок', 'Сотрудник бухгалтерии'))").run(textQuestion.id);
    const manager = await app.as('Директор по развитию');
    const q = (await manager.get(`/api/surveys/${closed.id}/results`)).json.data.questions[2];
    assert.deepEqual(q.answers, []);
    assert.equal(q.answersHidden, true);
  });
});

describe('обратная связь от клиентов', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  const send = (body) => app.request(null, 'POST', '/api/public/feedback', body);

  it('отзыв принимается без входа; некорректные данные отклоняются', async () => {
    const ok = await send({ name: 'Клиент', company: 'ООО «Тест»', score: 10, message: 'Всё отлично, спасибо команде.' });
    assert.equal(ok.status, 201);
    assert.equal((await send({ score: 11, message: 'Слишком высокая оценка' })).status, 400);
    assert.equal((await send({ score: 8, message: 'ок' })).status, 400);
  });

  it('поле-ловушка: бот получает успех, но отзыв не сохраняется', async () => {
    const before = app.db.prepare('SELECT COUNT(*) AS n FROM client_feedback').get().n;
    assert.equal((await send({ score: 1, message: 'Купите наши услуги', website: 'http://spam.example' })).status, 201);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM client_feedback').get().n, before);
  });

  it('руководитель видит отзывы и NPS, сотрудник — нет', async () => {
    const manager = await app.as('Директор по развитию');
    const { items, nps } = (await manager.get('/api/client-feedback')).json.data;
    assert.equal(items.length, 5);
    // Оценки 10, 9, 7, 4 из демо-данных и 10 из теста: 3 промоутера, 1 критик из 5 → NPS 40
    assert.deepEqual(nps, { value: 40, promoters: 3, detractors: 1, passives: 1, count: 5 });
    const marked = await manager.patch(`/api/client-feedback/${items[0].id}`, { status: 'processed' });
    assert.equal(marked.json.data.items[0].status, 'processed');
    assert.equal((await manager.patch(`/api/client-feedback/${items[0].id}`, { status: 'deleted' })).status, 400);
    const emp = await app.as('Сотрудник офиса');
    assert.equal((await emp.get('/api/client-feedback')).status, 403);
  });

  it('оценка принимается только числом', async () => {
    const fresh = await startTestApp();
    try {
      const post = (score) => fresh.request(null, 'POST', '/api/public/feedback', { score, message: 'Проверка типа оценки.' });
      assert.equal((await post('')).status, 400);
      assert.equal((await post(null)).status, 400);
      assert.equal((await post('7')).status, 400);
      assert.equal((await post(7)).status, 201);
    } finally {
      await fresh.close();
    }
  });

  it('публичная форма ограничена по числу отправок', async () => {
    const fresh = await startTestApp();
    try {
      const post = () => fresh.request(null, 'POST', '/api/public/feedback', { score: 9, message: 'Повторная отправка отзыва.' });
      const statuses = [];
      for (let i = 0; i < 6; i += 1) statuses.push((await post()).status);
      assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429]);
    } finally {
      await fresh.close();
    }
  });
});

describe('приложение на телефоне', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('отдаёт манифест, сервис-воркер и иконки с правильными типами', async () => {
    const manifest = await fetch(`${app.base}/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get('content-type'), /^application\/manifest\+json/);
    const body = await manifest.json();
    assert.equal(body.display, 'standalone');
    assert.deepEqual(body.icons.map((i) => i.sizes).sort(), ['192x192', '512x512', '512x512']);
    for (const icon of body.icons) {
      const res = await fetch(`${app.base}${icon.src}`);
      assert.equal(res.status, 200, icon.src);
      assert.equal(res.headers.get('content-type'), 'image/png');
    }
    const sw = await fetch(`${app.base}/sw.js`);
    assert.match(sw.headers.get('content-type'), /^text\/javascript/);
    assert.match(await sw.text(), /\/api\//, 'сервис-воркер не кэширует API');
  });
});

describe('рабочая установка', () => {
  it('за прокси адрес клиента берётся из X-Forwarded-For, иначе — адрес соединения', async () => {
    const { clientIp } = await import('../src/http.js');
    const req = { headers: { 'x-forwarded-for': '10.1.2.3, 172.16.0.1' }, socket: { remoteAddress: '127.0.0.1' } };
    assert.equal(clientIp(req, true), '10.1.2.3');
    assert.equal(clientIp(req, false), '127.0.0.1', 'без TRUST_PROXY заголовку не доверяем');
    assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '::1' } }, true), '::1');
  });

  it('по HTTPS cookie сессии помечается Secure', async () => {
    const app = await startTestApp({ secureCookie: true });
    try {
      const r = await app.request(null, 'POST', '/api/session', { userId: app.userId('Сотрудник офиса') });
      assert.match(r.headers.get('set-cookie'), /; Secure/);
    } finally {
      await app.close();
    }
    const plain = await startTestApp();
    try {
      const r = await plain.request(null, 'POST', '/api/session', { userId: plain.userId('Сотрудник офиса') });
      assert.doesNotMatch(r.headers.get('set-cookie'), /Secure/);
    } finally {
      await plain.close();
    }
  });

  it('без демо-данных в пустой базе только администратор', async () => {
    const app = await startTestApp({ seed: false });
    try {
      const users = app.db.prepare('SELECT name, role FROM users').all().map((u) => ({ ...u }));
      assert.deepEqual(users, [{ name: 'Администратор системы', role: 'admin' }]);
      assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, 0);
    } finally {
      await app.close();
    }
  });

  it('отчёт за период показывает охват по отделам и доверие без учёта анонимных', async () => {
    const app = await startTestApp();
    try {
      const manager = await app.as('Директор по развитию');
      const { engagement } = (await manager.get('/api/report?from=2026-01-01&to=2026-11-11')).json.data;
      assert.ok(engagement.overall.headcount >= 24);
      assert.ok(engagement.overall.participants > 0);
      const sales = engagement.coverage.find((d) => d.department === 'Продажи');
      assert.ok(sales.participants >= 1 && sales.participants <= sales.headcount);
      assert.ok(engagement.trust.authors > 0 && engagement.trust.repeat <= engagement.trust.authors);

      // Анонимное обращение нового автора не меняет ни охват, ни число авторов.
      const before = engagement;
      const emp = await app.as('Сотрудник офиса');
      await emp.post('/api/tickets', {
        type: 'problem', categoryId: app.db.prepare("SELECT id FROM categories WHERE name = 'Регламенты'").get().id,
        title: 'Анонимно о регламенте', description: 'Текст анонимного обращения для проверки.', isAnonymous: true,
      });
      const after = (await manager.get('/api/report?from=2026-01-01&to=2026-11-11')).json.data.engagement;
      assert.deepEqual(after.trust, before.trust);
      assert.deepEqual(after.overall, before.overall);
    } finally {
      await app.close();
    }
  });
});
