// Письма-уведомления (SMTP, демо-почта, согласие сотрудника) и рабочие контакты сотрудников.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startTestApp } from './helpers.js';
import { sendMail, buildMessage } from '../src/integrations/smtp.js';
import { createDemoSmtp, parseMessage } from '../src/integrations/demo-smtp.js';
import { IntegrationError } from '../src/integrations/clients.js';
import { readIntegrationConfig } from '../src/integrations/config.js';
import { parseContacts } from '../src/contacts.js';

const waitFor = async (check, ms = 2000) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('не дождались');
    await new Promise((r) => { setTimeout(r, 20); });
  }
};

describe('SMTP-клиент', () => {
  let smtp;
  let port;
  before(async () => { smtp = createDemoSmtp(); port = await smtp.listen(); });
  after(() => smtp.close());

  it('отправляет письмо в UTF-8: тема и текст доходят без искажений', async () => {
    const answer = await sendMail({ host: '127.0.0.1', port }, {
      from: 'golos@modus-demo.example', fromName: 'Голос сотрудника', to: 'employee1@modus-demo.example',
      subject: 'Обращение A-001: новый статус', text: 'Статус изменён.\n.\nСтрока с точкой не обрывает письмо.',
    });
    assert.match(answer, /принято/);
    const [letter] = smtp.messages.slice(-1);
    assert.deepEqual(letter.to, ['employee1@modus-demo.example']);
    assert.equal(letter.subject, 'Обращение A-001: новый статус');
    assert.equal(letter.text, 'Статус изменён.\n.\nСтрока с точкой не обрывает письмо.');
  });

  it('перевод строки в теме не добавляет заголовков', () => {
    const raw = buildMessage({ from: 'a@b.example', to: 'c@d.example', subject: 'Тема\r\nBcc: evil@x.example', text: 'x' });
    assert.ok(!/^Bcc:/m.test(raw));
    assert.equal(parseMessage(raw).subject, 'Тема Bcc: evil@x.example');
  });

  it('неверный адрес и пароль без шифрования — ошибка, письмо не уходит', async () => {
    await assert.rejects(sendMail({ host: '127.0.0.1', port }, { from: 'a@b.example', to: 'не адрес', subject: 's', text: 't' }), /неверный адрес/);
    await assert.rejects(
      sendMail({ host: '127.0.0.1', port, user: 'u', password: 'p' }, { from: 'a@b.example', to: 'c@d.example', subject: 's', text: 't' }),
      (e) => e instanceof IntegrationError && /шифрование/.test(e.message),
    );
  });

  it('отказ сервера — понятная ошибка', async () => {
    const refusing = net.createServer((s) => { s.write('554 сервис недоступен\r\n'); s.end(); });
    await new Promise((r) => refusing.listen(0, '127.0.0.1', r));
    try {
      await assert.rejects(sendMail({ host: '127.0.0.1', port: refusing.address().port }, { from: 'a@b.example', to: 'c@d.example', subject: 's', text: 't' }),
        /Почта: приветствие — 554/);
    } finally {
      refusing.close();
    }
  });

  it('адрес получателя из ответа сервера не попадает в текст ошибки', async () => {
    const bouncing = net.createServer((sock) => {
      sock.write('220 ok\r\n');
      sock.on('data', (chunk) => {
        const line = String(chunk);
        if (/^EHLO/.test(line)) sock.write('250 ok\r\n');
        else if (/^MAIL/.test(line)) sock.write('250 ok\r\n');
        else if (/^RCPT/.test(line)) sock.write('550 5.1.1 <secret.author@modus.example> unknown\r\n');
      });
    });
    await new Promise((r) => bouncing.listen(0, '127.0.0.1', r));
    try {
      await assert.rejects(
        sendMail({ host: '127.0.0.1', port: bouncing.address().port }, { from: 'a@b.example', to: 'secret.author@modus.example', subject: 's', text: 't' }),
        (e) => /RCPT — 550 5\.1\.1 \[адрес\] unknown/.test(e.message) && !e.message.includes('secret.author'),
      );
    } finally {
      bouncing.close();
    }
  });

  it('настройки: SMTP_HOST включает почту, без отправителя — ошибка при запуске', () => {
    assert.equal(readIntegrationConfig({ env: {} }).mail.mode, 'off');
    assert.equal(readIntegrationConfig({ env: {}, demoMode: true }).mail.mode, 'demo');
    const live = readIntegrationConfig({ env: { SMTP_HOST: 'smtp.modus.example', SMTP_USER: 'golos@modus.example', SMTP_SECURE: '1' } });
    assert.equal(live.mail.port, 465);
    assert.equal(live.mail.from, 'golos@modus.example');
    assert.throws(() => readIntegrationConfig({ env: { SMTP_HOST: 'smtp.modus.example' } }), /SMTP_FROM/);
  });
});

describe('письма-уведомления в демо-режиме', () => {
  let app;
  before(async () => {
    app = await startTestApp({ demoMode: true });
    await waitFor(() => app.demoSmtp.port());
  });
  after(() => app.close());

  it('автор получает копию уведомления на рабочую почту', async () => {
    const handler = await app.as('Руководитель закупок');
    await handler.post(`/api/tickets/${app.ticketId('A-001')}/status`, { status: 'in_review', comment: 'Смотрим' });
    await app.delivery.idle();
    const letter = app.demoSmtp.messages.find((m) => m.to[0] === 'employee1@modus-demo.example');
    assert.ok(letter, 'письмо дошло до демо-почты');
    assert.match(letter.subject, /^Голос сотрудника: A-001/);
    assert.match(letter.text, /Открыть: http:\/\/127\.0\.0\.1:\d+\/#\/t\/\d+/);
    const row = app.db.prepare("SELECT status FROM outbox WHERE channel = 'email' ORDER BY id DESC LIMIT 1").get();
    assert.equal(row.status, 'sent');
    const page = await (await fetch(`${app.base}/demo-portal/mail/`)).text();
    assert.match(page, /Демо-почта/);
  });

  it('сотрудник отключает письма — уведомления остаются, писем нет', async () => {
    const author = await app.as('Сотрудник закупок');
    const me = (await author.get('/api/me')).json.data;
    assert.equal(me.email, 'employee1@modus-demo.example');
    assert.equal(me.emailNotify, true);
    assert.equal((await author.patch('/api/me/notifications', { email: 'нет' })).status, 400);
    assert.equal((await author.patch('/api/me/notifications', { email: false })).status, 200);
    const sentBefore = app.demoSmtp.messages.length;
    const handler = await app.as('Руководитель закупок');
    const comment = await handler.post(`/api/tickets/${app.ticketId('A-001')}/comments`, { body: 'Уточните модель оборудования' });
    assert.equal(comment.status, 200);
    await app.delivery.idle();
    assert.equal(app.demoSmtp.messages.length, sentBefore);
    assert.ok((await author.get('/api/notifications')).json.data.unread > 0, 'уведомление в системе есть');
    await author.patch('/api/me/notifications', { email: true });
  });

  it('у анонимного обращения журнал скрывает получателя письма', async () => {
    const emp = await app.as('Сотрудник офиса');
    const created = await emp.post('/api/tickets', {
      type: 'problem', categoryId: app.db.prepare("SELECT id FROM categories WHERE name = 'Регламенты'").get().id,
      title: 'Анонимно о регламенте согласования', description: 'Регламент согласования счетов устарел и не соблюдается.', isAnonymous: true,
    });
    const handler = await app.as('Ответственный за процессы');
    await handler.post(`/api/tickets/${created.json.data.id}/status`, { status: 'in_review', comment: 'Взяли' });
    await app.delivery.idle();
    const row = app.db.prepare("SELECT recipient FROM outbox WHERE channel = 'email' AND ticket_id = ? ORDER BY id DESC LIMIT 1").get(created.json.data.id);
    assert.match(row.recipient, /скрыт/);
    // Демо-почта открыта без входа: адрес получателя письма об анонимном обращении на ней не показывается.
    const letter = app.demoSmtp.messages.at(-1);
    assert.equal(letter.hiddenRecipient, true);
    const page = await (await fetch(`${app.base}/demo-portal/mail/`)).text();
    assert.match(page, /Кому: скрыто \(анонимное обращение\)/);
  });
});

describe('без почтового сервера', () => {
  it('письма остаются в журнале как имитация', async () => {
    const app = await startTestApp();
    try {
      const handler = await app.as('Руководитель закупок');
      await handler.post(`/api/tickets/${app.ticketId('A-001')}/status`, { status: 'in_review', comment: 'Смотрим' });
      await app.delivery.idle();
      const row = app.db.prepare("SELECT status FROM outbox WHERE channel = 'email' ORDER BY id DESC LIMIT 1").get();
      assert.equal(row.status, 'simulated');
    } finally {
      await app.close();
    }
  });
});

describe('рабочие контакты', () => {
  let app;
  before(async () => { app = await startTestApp({ demoMode: true }); });
  after(() => app.close());

  it('проверка полей: почта, телефон, длина', () => {
    assert.deepEqual(parseContacts({ email: ' Ivan@Modus.Example ', phone: '+7 (701) 123-45-67', position: 'Инженер' }),
      { email: 'ivan@modus.example', phone: '+7 (701) 123-45-67', position: 'Инженер' });
    assert.throws(() => parseContacts({ email: 'не почта' }), /Почта/);
    assert.throws(() => parseContacts({ phone: '8-800-ЗВОНИ' }), /Телефон/);
    assert.throws(() => parseContacts({ position: 'x'.repeat(81) }), /Должность/);
    assert.deepEqual(parseContacts({ email: '' }), { email: null, phone: undefined, position: undefined });
  });

  it('администратор правит контакты, изменение — в журнале; остальным нельзя', async () => {
    const admin = await app.as('Администратор системы');
    const id = app.userId('Ответственный за договоры');
    const res = await admin.patch(`/api/admin/users/${id}/contacts`, { position: 'Юрист', phone: '+7 (000) 111-22-33' });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.find((u) => u.id === id).position, 'Юрист');
    assert.equal((await admin.patch(`/api/admin/users/${id}/contacts`, { email: 'плохо' })).status, 400);
    assert.ok((await admin.get('/api/admin/audit')).json.data.some((a) => a.action === 'Контакты изменены'));
    const emp = await app.as('Сотрудник офиса');
    assert.equal((await emp.patch(`/api/admin/users/${id}/contacts`, { position: 'x' })).status, 403);
    const listed = (await app.request(null, 'GET', '/api/demo-users')).json.data.users;
    assert.equal(listed[0].email, undefined, 'список для входа контакты не показывает');
  });

  it('карточка: контакты ответственного видит автор, контакты автора — только рассматривающий', async () => {
    const id = app.ticketId('A-009');
    const author = await app.as('Менеджер по продажам');
    const forAuthor = (await author.get(`/api/tickets/${id}`)).json.data;
    assert.equal(forAuthor.contacts.assignee.position, 'Юрист');
    assert.equal(forAuthor.contacts.author, null);
    const handler = await app.as('Ответственный за договоры');
    const forHandler = (await handler.get(`/api/tickets/${id}`)).json.data;
    assert.match(forHandler.contacts.author.email, /@modus-demo\.example$/);
  });

  it('у анонимного обращения контактов автора нет ни у кого', async () => {
    const emp = await app.as('Сотрудник офиса');
    const created = await emp.post('/api/tickets', {
      type: 'problem', categoryId: app.db.prepare("SELECT id FROM categories WHERE name = 'Регламенты'").get().id,
      title: 'Анонимно о регламенте', description: 'Регламент согласования счетов устарел и не соблюдается.', isAnonymous: true,
    });
    const handler = await app.as('Ответственный за процессы');
    const detail = (await handler.get(`/api/tickets/${created.json.data.id}`)).json.data;
    assert.equal(detail.author, null);
    assert.equal(detail.contacts.author, null);
  });

  it('загрузка оргструктуры заполняет контакты из Битрикс24, пустое на портале не стирает введённое', async () => {
    app.db.prepare("UPDATE users SET email = NULL, phone = NULL WHERE name = 'Сотрудник офиса'").run();
    const admin = await app.as('Администратор системы');
    await admin.post('/api/admin/integrations/b24/org-apply');
    const office = app.db.prepare("SELECT email, phone FROM users WHERE name = 'Сотрудник офиса'").get();
    assert.match(office.email, /@modus-demo\.example$/);
    assert.match(office.phone, /^\+7 \(000\)/);
    assert.equal(app.db.prepare("SELECT position FROM users WHERE name = 'Ответственный за договоры'").get().position, 'Юрист');
    assert.match(app.db.prepare("SELECT email FROM users WHERE name = 'Инженер сервиса'").get().email, /@modus-demo\.example$/, 'новый сотрудник — с почтой');
  });
});
