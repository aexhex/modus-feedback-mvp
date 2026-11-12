import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { tokenize, jaccard, findSimilar } from '../src/similarity.js';

describe('администрирование', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('создание категории с правилом маршрутизации и её применение', async () => {
    const admin = await app.as('Администратор системы');
    const created = await admin.post('/api/admin/categories', {
      name: 'Охрана труда', assigneeId: app.userId('Административный руководитель'),
    });
    assert.equal(created.status, 201);
    const dup = await admin.post('/api/admin/categories', { name: 'Охрана труда' });
    assert.equal(dup.status, 400);
    const emp = await app.as('Сотрудник офиса');
    const t = (await emp.post('/api/tickets', {
      type: 'problem', categoryId: created.json.data.id, title: 'Скользкий пол у входа', description: 'После дождя у входа очень скользко.',
    })).json.data;
    assert.equal(t.assignee.name, 'Административный руководитель');
  });

  it('нельзя назначить сотрудника-не-обработчика ответственным', async () => {
    const admin = await app.as('Администратор системы');
    const catId = app.db.prepare("SELECT id FROM categories WHERE name = 'Обучение'").get().id;
    const r = await admin.patch(`/api/admin/categories/${catId}`, { assigneeId: app.userId('Сотрудник офиса') });
    assert.equal(r.status, 400);
  });

  it('отключённая категория недоступна для новых обращений', async () => {
    const admin = await app.as('Администратор системы');
    const catId = app.db.prepare("SELECT id FROM categories WHERE name = 'Коммуникации'").get().id;
    await admin.patch(`/api/admin/categories/${catId}`, { isActive: false });
    const emp = await app.as('Сотрудник офиса');
    const r = await emp.post('/api/tickets', { type: 'idea', categoryId: catId, title: 'Новая идея', description: 'Описание идеи достаточно длинное.' });
    assert.equal(r.status, 400);
  });

  it('администратор не может отключить сам себя; некорректный флаг — 400', async () => {
    const admin = await app.as('Администратор системы');
    assert.equal((await admin.patch(`/api/admin/users/${app.userId('Администратор системы')}`, { isAvailable: false })).status, 400);
    assert.equal((await admin.patch(`/api/admin/users/${app.userId('IT-специалист')}`, { isAvailable: 'no' })).status, 400);
  });
});

describe('вложения', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  const file = (name, content = 'тестовый файл') => ({ name, dataBase64: Buffer.from(content).toString('base64') });

  it('автор прикрепляет файл, обработчик скачивает, посторонний — нет', async () => {
    const id = app.ticketId('A-001');
    const emp = await app.as('Сотрудник закупок');
    const up = await emp.post(`/api/tickets/${id}/attachments`, file('пример заявки.txt'));
    assert.equal(up.status, 201);
    const attId = up.json.data.id;

    const handler = await app.as('Руководитель закупок');
    const res = await handler.raw(`/api/attachments/${attId}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.equal(await res.text(), 'тестовый файл');
    assert.equal(res.headers.get('cache-control'), 'no-store');

    const stranger = await app.as('Сотрудник офиса');
    assert.equal((await stranger.raw(`/api/attachments/${attId}`)).status, 404);
  });

  it('в анонимном обращении имя файла автора заменяется нейтральным', async () => {
    const emp = await app.as('Сотрудник офиса');
    const created = await emp.post('/api/tickets', {
      type: 'problem', categoryId: app.db.prepare("SELECT id FROM categories WHERE name = 'Регламенты'").get().id, isAnonymous: true,
      title: 'Анонимная проблема с файлом', description: 'Описание анонимной проблемы с файлом.',
    });
    const id = created.json.data.id;
    const up = await emp.post(`/api/tickets/${id}/attachments`, file('Отчёт Сотрудник офиса.docx'));
    assert.equal(up.json.data.name, 'Вложение 1.docx');
    const handler = await app.as('Ответственный за процессы');
    const ticket = (await handler.get(`/api/tickets/${id}`)).json.data;
    assert.ok(!JSON.stringify(ticket).includes('Отчёт Сотрудник офиса'), 'исходное имя нигде не видно');
  });

  it('запрещённое расширение и битые данные отклоняются', async () => {
    const id = app.ticketId('A-001');
    const emp = await app.as('Сотрудник закупок');
    assert.equal((await emp.post(`/api/tickets/${id}/attachments`, file('evil.html'))).status, 400);
    assert.equal((await emp.post(`/api/tickets/${id}/attachments`, { name: 'a.txt', dataBase64: '###' })).status, 400);
  });
});

describe('статика и безопасность', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('выход за пределы public запрещён', async () => {
    const res = await fetch(`${app.base}/..%2fserver.js`);
    assert.equal(res.status, 404);
  });

  it('неизвестный метод API — 404, ответы с заголовками безопасности', async () => {
    const r = await app.request(null, 'GET', '/api/nope');
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });

  it('некорректный JSON — 400', async () => {
    const res = await fetch(`${app.base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    assert.equal(res.status, 400);
  });
});

describe('похожесть текстов', () => {
  it('стемминг сводит словоформы', () => {
    assert.ok(tokenize('заявках').has('заявк'));
    assert.ok(tokenize('Заявки').has('заявк'));
  });
  it('jaccard пустых множеств равен 0', () => {
    assert.equal(jaccard(new Set(), new Set(['a'])), 0);
  });
  it('findSimilar ранжирует по сходству', () => {
    const res = findSimilar('документы статус ответственный', [
      { id: 1, title: 'Статус документов', description: 'не видно ответственного' },
      { id: 2, title: 'Обучение', description: 'семинар' },
    ]);
    assert.equal(res[0].id, 1);
    assert.equal(res.length, 1);
  });
});
