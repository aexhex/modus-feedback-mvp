import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestApp } from './helpers.js';

const categoryId = (app, name) => app.db.prepare('SELECT id FROM categories WHERE name = ?').get(name).id;
const file = { name: 'note.txt', dataBase64: Buffer.from('текст').toString('base64') };

describe('голосование за идеи', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('у сотрудника 5 голосов; демо-голоса уже распределены', async () => {
    const office = await app.as('Сотрудник офиса');
    assert.deepEqual((await office.get('/api/votes')).json.data, { budget: 5, perIdea: 3, used: 5, left: 0 });
    const coordinator = await app.as('Координатор проекта');
    assert.equal((await coordinator.get('/api/votes')).json.data.left, 5);
  });

  it('распределение голосов: лимит на идею и общий бюджет', async () => {
    const voter = await app.as('Координатор проекта');
    const first = await voter.post(`/api/tickets/${app.ticketId('A-020')}/vote`, { count: 3 });
    assert.equal(first.status, 200);
    assert.equal(first.json.data.voting.mine, 3);
    assert.equal(first.json.data.voting.left, 2);
    assert.equal(first.json.data.votesCount, 8);
    const tooMany = await voter.post(`/api/tickets/${app.ticketId('A-002')}/vote`, { count: 3 });
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.json.error, /свободно 2 из 5/);
    assert.equal((await voter.post(`/api/tickets/${app.ticketId('A-002')}/vote`, { count: 2 })).status, 200);
    assert.equal((await voter.get('/api/votes')).json.data.left, 0);
    // Перераспределение: снятые с одной идеи голоса можно отдать другой.
    await voter.post(`/api/tickets/${app.ticketId('A-020')}/vote`, { count: 0 });
    assert.equal((await voter.get('/api/votes')).json.data.left, 3);
  });

  it('ограничения: своя идея, не из ленты, некорректное число', async () => {
    const voter = await app.as('Координатор проекта');
    assert.equal((await voter.post(`/api/tickets/${app.ticketId('A-014')}/vote`, { count: 1 })).status, 400);
    assert.equal((await voter.post(`/api/tickets/${app.ticketId('A-013')}/vote`, { count: 1 })).status, 400);
    assert.equal((await voter.post(`/api/tickets/${app.ticketId('A-001')}/vote`, { count: 1 })).status, 404);
    assert.equal((await voter.post(`/api/tickets/${app.ticketId('A-020')}/vote`, { count: 4 })).status, 400);
    assert.equal((await voter.post(`/api/tickets/${app.ticketId('A-020')}/vote`, { count: '2' })).status, 400);
    const own = (await voter.get(`/api/tickets/${app.ticketId('A-014')}`)).json.data.voting;
    assert.equal(own.canVote, false);
  });

  it('повторное открытие отклонённой идеи не возвращает отданные голоса', async () => {
    const voter = await app.as('Сотрудник проектирования');
    const handler = await app.as('Руководитель продаж');
    await handler.post(`/api/tickets/${app.ticketId('A-010')}/status`, { status: 'rejected', resolution: 'Пока не подходит' });
    assert.equal((await voter.get('/api/votes')).json.data.left, 5);
    await voter.post(`/api/tickets/${app.ticketId('A-012')}/vote`, { count: 3 });
    await voter.post(`/api/tickets/${app.ticketId('A-006')}/vote`, { count: 2 });
    await handler.post(`/api/tickets/${app.ticketId('A-010')}/status`, { status: 'in_review', comment: 'Возвращаемся' });
    assert.deepEqual((await voter.get('/api/votes')).json.data, { budget: 5, perIdea: 3, used: 5, left: 0 });
    await voter.post(`/api/tickets/${app.ticketId('A-012')}/vote`, { count: 0 });
    await voter.post(`/api/tickets/${app.ticketId('A-006')}/vote`, { count: 0 });
    await voter.post(`/api/tickets/${app.ticketId('A-010')}/vote`, { count: 3 });
  });

  it('идея, убранная из ленты, возвращает голоса', async () => {
    const voter = await app.as('Сотрудник проектирования');
    assert.equal((await voter.get('/api/votes')).json.data.left, 2);
    const author = await app.as('Менеджер по продажам');
    await author.post(`/api/tickets/${app.ticketId('A-010')}/publish`, { isPublic: false });
    assert.equal((await voter.get('/api/votes')).json.data.left, 5);
    await author.post(`/api/tickets/${app.ticketId('A-010')}/publish`, { isPublic: true });
    // Повторная публикация не возвращает снятые голоса.
    assert.equal((await voter.get('/api/votes')).json.data.left, 5);
  });

  it('лента сортируется по голосам; рассмотренная идея возвращает голоса', async () => {
    const office = await app.as('Сотрудник офиса');
    const feed = (await office.get('/api/tickets?scope=feed&sort=votes&limit=3')).json.data;
    assert.deepEqual(feed.slice(0, 2).map((t) => t.code).sort(), ['A-014', 'A-020']);
    assert.ok(feed[0].votesCount >= feed[1].votesCount && feed[1].votesCount >= feed[2].votesCount);

    const handler = await app.as('Руководитель подразделения');
    await handler.post(`/api/tickets/${app.ticketId('A-020')}/status`, { status: 'in_review', comment: 'Берём' });
    await handler.post(`/api/tickets/${app.ticketId('A-020')}/status`, { status: 'rejected', resolution: 'Уже публикуем в общей рассылке' });
    assert.equal((await office.get('/api/votes')).json.data.left, 3);
    assert.equal((await office.post(`/api/tickets/${app.ticketId('A-020')}/vote`, { count: 1 })).status, 400);
  });
});

describe('переназначение при отключении пользователя', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('открытые обращения уходят следующему по правилу категории', async () => {
    const admin = await app.as('Администратор системы');
    const leaver = app.userId('Руководитель проектов');
    await admin.patch(`/api/admin/categories/${categoryId(app, 'Проектная деятельность')}`, { assigneeId: null });
    await admin.patch(`/api/admin/categories/${categoryId(app, 'Планирование ресурсов')}`, { fallbackId: null });
    const r = await admin.patch(`/api/admin/users/${leaver}`, { isActive: false });
    assert.equal(r.status, 200);

    const manager = await app.as('Директор по развитию');
    const t = (await manager.get(`/api/tickets/${app.ticketId('A-013')}`)).json.data;
    assert.equal(t.assignee.name, 'Руководитель проектирования');
    assert.ok(t.events.some((e) => /Руководитель проектов больше не обрабатывает/.test(e.body ?? '')));
    const heir = await app.as('Руководитель проектирования');
    assert.ok((await heir.get('/api/notifications')).json.data.items.some((n) => /Вам передано обращение A-013/.test(n.text)));
    const audit = (await admin.get('/api/admin/audit')).json.data;
    assert.ok(audit.some((a) => /переназначено обращений: 1/.test(a.details)));
  });

  it('то же при переводе обработчика в сотрудники; «в отпуске» обращения не забирает', async () => {
    const admin = await app.as('Администратор системы');
    const docsAdmin = app.userId('Администратор документов');
    await admin.patch(`/api/admin/users/${docsAdmin}`, { isAvailable: false });
    const manager = await app.as('Директор по развитию');
    assert.equal((await manager.get(`/api/tickets/${app.ticketId('A-019')}`)).json.data.assignee.name, 'Администратор документов');

    await admin.patch(`/api/admin/categories/${categoryId(app, 'Хранение документов')}`, { assigneeId: null });
    await admin.patch(`/api/admin/categories/${categoryId(app, 'Документооборот')}`, { fallbackId: null });
    assert.equal((await admin.patch(`/api/admin/users/${docsAdmin}`, { role: 'employee' })).status, 200);
    const moved = (await manager.get(`/api/tickets/${app.ticketId('A-019')}`)).json.data;
    assert.equal(moved.assignee.name, 'Ответственный за процессы');
  });
});

describe('приглашение не выдаёт автора анонимного обращения', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('автора и постороннего коллегу приглашают одинаково', async () => {
    const authorName = 'Руководитель продаж';
    const author = await app.as(authorName);
    const ticket = (await author.post('/api/tickets', {
      type: 'problem', categoryId: categoryId(app, 'Обучение'), title: 'Анонимно от обработчика',
      description: 'Проверка, что приглашение не раскрывает автора.', isAnonymous: true,
    })).json.data;
    const handler = await app.as('Ответственный за обучение');
    const toAuthor = await handler.post(`/api/tickets/${ticket.id}/invite`, { userId: app.userId(authorName) });
    const toOther = await handler.post(`/api/tickets/${ticket.id}/invite`, { userId: app.userId('IT-специалист') });
    assert.equal(toAuthor.status, 200);
    assert.equal(toOther.status, 200);
    const again = [
      await handler.post(`/api/tickets/${ticket.id}/invite`, { userId: app.userId(authorName) }),
      await handler.post(`/api/tickets/${ticket.id}/invite`, { userId: app.userId('IT-специалист') }),
    ];
    assert.deepEqual(again.map((r) => [r.status, r.json.error]), [[400, 'Коллега уже приглашён'], [400, 'Коллега уже приглашён']]);
    assert.equal(toOther.json.data.author, null);
    // В журнале имитации по анонимному обращению скрыты все получатели, включая приглашённых.
    const admin = await app.as('Администратор системы');
    const entries = (await admin.get('/api/admin/outbox')).json.data.filter((o) => o.payload.LINK === `/#/t/${ticket.id}`);
    assert.ok(entries.length >= 3);
    assert.ok(entries.every((o) => o.recipient === 'Получатель скрыт (анонимное обращение)'));
  });
});

describe('сводка за неделю', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('сравнение с прошлой неделей и готовый текст', async () => {
    const manager = await app.as('Директор по развитию');
    const d = (await manager.get('/api/digest')).json.data;
    assert.equal(d.from, '2026-11-05');
    assert.equal(d.to, '2026-11-11');
    const previous = (await manager.get('/api/report?from=2026-10-29&to=2026-11-04')).json.data;
    assert.equal(d.delta.created, d.totals.created - previous.totals.created);
    assert.equal(d.delta.resolved, d.totals.resolved - previous.totals.resolved);
    assert.equal(d.overdue.length, 4);
    assert.equal(d.topVoted[0].votes, 5);
    // Отзывы за 7 дней: 9, 7 и 4 — один промоутер, один критик.
    assert.deepEqual([d.clients.count, d.clients.value], [3, 0]);
    assert.match(d.text, /^Сводка «Голос сотрудника» за 05\.11\.2026 — 11\.11\.2026/);
    assert.match(d.text, /Требуют внимания:/);
  });

  it('рассылка (имитация) уходит руководителям и администраторам', async () => {
    const manager = await app.as('Директор по развитию');
    assert.equal((await manager.post('/api/digest/send')).json.data.recipients, 2);
    const admin = await app.as('Администратор системы');
    const sent = (await admin.get('/api/admin/outbox')).json.data.filter((o) => o.payload.LINK === '/#/digest');
    assert.deepEqual(sent.map((o) => o.recipient).sort(), ['Администратор системы', 'Директор по развитию']);
    const emp = await app.as('Сотрудник офиса');
    assert.equal((await emp.get('/api/digest')).status, 403);
    assert.equal((await emp.post('/api/digest/send')).status, 403);
  });
});

describe('импорт пользователей из CSV', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('корректные строки добавляются, ошибочные — с причиной', async () => {
    const admin = await app.as('Администратор системы');
    const csv = [
      '﻿Имя;Роль;Подразделение',
      'Инженер ПНР;ответственный;Сервис',
      'Кладовщик;Сотрудник;Склад',
      'IT-специалист;ответственный;IT',
      'Кто-то;директор;Офис',
      '"Монтажник, старший";employee;Монтаж',
    ].join('\r\n');
    const r = (await admin.post('/api/admin/users/import', { csv })).json.data;
    assert.deepEqual(r.created, ['Инженер ПНР', 'Кладовщик', 'Монтажник, старший']);
    assert.deepEqual(r.skipped.map((s) => s.line), [4, 5]);
    assert.match(r.skipped[0].reason, /уже есть/);
    assert.match(r.skipped[1].reason, /неизвестная роль/);
    assert.equal(r.users.find((u) => u.name === 'Инженер ПНР').role, 'handler');
    assert.ok((await admin.get('/api/admin/audit')).json.data.some((a) => a.action === 'Импорт пользователей'));
  });

  it('кавычки с разделителем внутри и имя, похожее на заголовок', async () => {
    const admin = await app.as('Администратор системы');
    const csv = 'Имяров Пётр;сотрудник;Склад\n"Иванов; мл.";сотрудник;"Отдел ""Север""' + '"';
    const r = (await admin.post('/api/admin/users/import', { csv })).json.data;
    assert.deepEqual(r.created, ['Имяров Пётр', 'Иванов; мл.']);
    assert.equal(r.users.find((u) => u.name === 'Иванов; мл.').department, 'Отдел "Север"');
  });

  it('разделитель «,» внутри кавычек сохраняется', async () => {
    const admin = await app.as('Администратор системы');
    const r = (await admin.post('/api/admin/users/import', { csv: '"Doe, Jane",employee,Sales\nJohn Smith,employee,"Sales, Europe"' })).json.data;
    assert.deepEqual(r.created, ['Doe, Jane', 'John Smith']);
    assert.equal(r.users.find((u) => u.name === 'John Smith').department, 'Sales, Europe');
  });

  it('разделитель «,» без заголовка; пустой файл и права', async () => {
    const admin = await app.as('Администратор системы');
    const r = (await admin.post('/api/admin/users/import', { csv: 'Сметчик,сотрудник,Проектирование' })).json.data;
    assert.deepEqual(r.created, ['Сметчик']);
    assert.equal((await admin.post('/api/admin/users/import', { csv: '  ' })).status, 400);
    const manager = await app.as('Директор по развитию');
    assert.equal((await manager.post('/api/admin/users/import', { csv: 'А;сотрудник;Б' })).status, 403);
  });
});

describe('сброс демо-данных', () => {
  it('возвращает исходный датасет, удаляет файлы и сессии', async () => {
    const app = await startTestApp({ demoMode: true });
    try {
      const emp = await app.as('Сотрудник офиса');
      const created = (await emp.post('/api/tickets', {
        type: 'idea', categoryId: categoryId(app, 'Обучение'), title: 'Временная идея', description: 'Будет удалена при сбросе.',
      })).json.data;
      await emp.post(`/api/tickets/${created.id}/attachments`, file);
      assert.equal(readdirSync(app.uploadsDir).length, 1);
      writeFileSync(join(app.uploadsDir, 'not-an-attachment.db'), 'чужой файл');

      const admin = await app.as('Администратор системы');
      const r = await admin.post('/api/admin/demo-reset');
      assert.equal(r.status, 200);
      assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
      assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, 20);
      assert.deepEqual(readdirSync(app.uploadsDir), ['not-an-attachment.db']);
      assert.equal((await admin.get('/api/me')).status, 401);
      assert.equal((await emp.get('/api/me')).status, 401);

      const fresh = await app.as('Администратор системы');
      assert.equal((await fresh.get('/api/admin/templates')).json.data.length, 6);
      assert.ok((await fresh.get('/api/admin/audit')).json.data.some((a) => a.action === 'Демо-данные сброшены'));
      const manager = await app.as('Директор по развитию');
      assert.ok((await manager.get('/api/notifications')).json.data.items.some((n) => n.text.startsWith('Просрочка A-007')));
      assert.equal((await manager.post('/api/admin/demo-reset')).status, 403);
    } finally {
      await app.close();
    }
  });

  it('без явного включения демо-режима сброс запрещён', async () => {
    const app = await startTestApp();
    try {
      const admin = await app.as('Администратор системы');
      assert.equal((await admin.get('/api/meta')).json.data.demoMode, false);
      assert.equal((await admin.post('/api/admin/demo-reset')).status, 403);
      assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n > 0, true);
    } finally {
      await app.close();
    }
  });
});

describe('исправление обращения автором и фильтр по дате', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('автор исправляет обращение, пока его не взяли в работу', async () => {
    const id = app.ticketId('A-001');
    const author = await app.as('Сотрудник закупок');
    const detail = (await author.get(`/api/tickets/${id}`)).json.data;
    assert.equal(detail.permissions.canEdit, true);
    const r = await author.patch(`/api/tickets/${id}`, { title: 'В заявках на оборудование нет параметров', description: detail.description, proposedSolution: 'Обязательные поля в шаблоне' });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.title, 'В заявках на оборудование нет параметров');
    assert.ok(r.json.data.events.some((e) => e.kind === 'edited' && /тема, предлагаемое решение/.test(e.body)));
    const handler = await app.as('Руководитель закупок');
    assert.ok((await handler.get('/api/notifications')).json.data.items.some((n) => /A-001: автор исправил обращение/.test(n.text)));
    assert.equal((await handler.patch(`/api/tickets/${id}`, { title: 'Чужая правка', description: 'Описание чужой правки.' })).status, 403);
    assert.equal((await author.patch(`/api/tickets/${id}`, { title: 'кр', description: 'Описание достаточно длинное.' })).status, 400);
  });

  it('после взятия в работу текст не меняется', async () => {
    const author = await app.as('Менеджер по продажам');
    const id = app.ticketId('A-009');
    assert.equal((await author.get(`/api/tickets/${id}`)).json.data.permissions.canEdit, false);
    assert.equal((await author.patch(`/api/tickets/${id}`, { title: 'Новая тема', description: 'Новое описание обращения.' })).status, 400);
  });

  it('реестр фильтруется по дате подачи', async () => {
    const manager = await app.as('Директор по развитию');
    const all = (await manager.get('/api/tickets?limit=100')).json.meta.total;
    const week = (await manager.get('/api/tickets?from=2026-11-05&to=2026-11-11&limit=100')).json;
    assert.ok(week.meta.total > 0 && week.meta.total < all);
    assert.ok(week.data.every((t) => t.createdAt >= '2026-11-04T21:00:00.000Z'));
    const old = (await manager.get('/api/tickets?to=2026-10-01&limit=100')).json.meta.total;
    assert.equal(week.meta.total + old <= all, true);
    assert.equal((await manager.get('/api/tickets?from=05.11.2026')).status, 400);
  });
});
