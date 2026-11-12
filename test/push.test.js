// Push-уведомления (Web Push): шифрование по RFC 8291, подпись VAPID, подписки, доставка на устройство.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createECDH, createDecipheriv, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { startTestApp } from './helpers.js';
import { encryptPayload, vapidAuthorization, isPushEndpoint, vapidKeys } from '../src/integrations/webpush.js';
import { openDatabase } from '../src/db.js';

// Устройство: свои ключи (как у браузера) и расшифровка того, что пришло от службы push.
function device() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
  const decrypt = (body) => {
    const salt = body.subarray(0, 16);
    const idlen = body.readUInt8(20);
    const asPublic = body.subarray(21, 21 + idlen);
    const data = body.subarray(21 + idlen);
    const secret = ecdh.computeSecret(asPublic);
    const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
    const ikm = Buffer.from(hkdfSync('sha256', secret, auth, info, 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(data.subarray(-16));
    const plain = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
    return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString('utf8'));
  };
  return { keys, decrypt };
}

describe('шифрование и подпись Web Push', () => {
  it('совпадает с примером из RFC 8291 байт в байт', () => {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'));
    const out = encryptPayload(
      { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
      'When I grow up, I want to be a watermelon',
      { salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'), serverEcdh: ecdh },
    );
    assert.equal(out.toString('base64url'),
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  });

  it('VAPID: подпись ES256 проверяется публичным ключом сервера, адресат — служба push', () => {
    const keys = vapidKeys(openDatabase(':memory:'), {});
    const header = vapidAuthorization(keys, 'https://fcm.googleapis.com/fcm/send/abc', 'mailto:golos@modus.example', 1_800_000_000);
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    assert.equal(k, keys.publicKey);
    const [h, c, s] = jwt.split('.');
    const claims = JSON.parse(Buffer.from(c, 'base64url'));
    assert.deepEqual(claims, { aud: 'https://fcm.googleapis.com', exp: 1_800_000_000 + 12 * 3600, sub: 'mailto:golos@modus.example' });
    const raw = Buffer.from(keys.publicKey, 'base64url');
    const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
    assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  });

  it('ключи сервера создаются один раз и сохраняются', () => {
    const db = openDatabase(':memory:');
    assert.deepEqual(vapidKeys(db, {}), vapidKeys(db, {}));
  });

  it('адрес подписки — только службы push браузеров', () => {
    assert.ok(isPushEndpoint('https://fcm.googleapis.com/fcm/send/abc'));
    assert.ok(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc'));
    assert.ok(isPushEndpoint('https://web.push.apple.com/abc'));
    assert.ok(!isPushEndpoint('http://fcm.googleapis.com/fcm/send/abc'), 'только HTTPS');
    assert.ok(!isPushEndpoint('https://127.0.0.1/x'));
    assert.ok(!isPushEndpoint('https://fcm.googleapis.com.evil.example/x'));
    assert.ok(!isPushEndpoint('https://fcm.googleapis.com:8443/x'), 'без порта');
    assert.ok(!isPushEndpoint('https://user:pass@fcm.googleapis.com/x'), 'без логина');
    assert.ok(!isPushEndpoint('не адрес'));
  });
});

describe('подписки устройств', () => {
  let app;
  before(async () => { app = await startTestApp(); });
  after(() => app.close());

  it('чужой адрес отклоняется, подписка устройства сохраняется и переходит к вошедшему', async () => {
    const { keys } = device();
    const emp = await app.as('Сотрудник офиса');
    assert.match((await emp.get('/api/push/key')).json.data.publicKey, /^B[\w-]{86}$/);
    assert.equal((await emp.post('/api/me/push', { endpoint: 'https://intranet.local/hook', keys })).status, 400);
    assert.equal((await emp.post('/api/me/push', { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'bad', auth: 'bad' } })).status, 400);
    const endpoint = 'https://fcm.googleapis.com/fcm/send/device-1';
    assert.equal((await emp.post('/api/me/push', { endpoint, keys })).json.data.devices, 1);
    const other = await app.as('Сотрудник закупок');
    await other.post('/api/me/push', { endpoint, keys });
    assert.equal(app.db.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint = ?').get(endpoint).user_id, app.userId('Сотрудник закупок'));
    assert.equal((await other.post('/api/me/push/remove', { endpoint })).json.data.devices, 0);
    assert.equal((await app.request(null, 'POST', '/api/me/push', { endpoint, keys })).status, 401);
  });
});

describe('доставка push на устройство', () => {
  let app;
  let pushService;
  let base;
  const received = [];
  let reply = 201;
  before(async () => {
    pushService = createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks), path: req.url });
        res.writeHead(reply).end();
      });
    });
    await new Promise((r) => pushService.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${pushService.address().port}`;
    app = await startTestApp({ pushCheckHost: false });
  });
  after(async () => { await app.close(); await new Promise((r) => pushService.close(r)); });

  it('уведомление приходит зашифрованным, устройство его расшифровывает', async () => {
    const author = device();
    const emp = await app.as('Сотрудник закупок');
    await emp.post('/api/me/push', { endpoint: `${base}/send/author`, keys: author.keys });
    const handler = await app.as('Руководитель закупок');
    await handler.post(`/api/tickets/${app.ticketId('A-001')}/status`, { status: 'in_review', comment: 'Смотрим' });
    await app.delivery.idle();
    const push = received.find((r) => r.path === '/send/author');
    assert.ok(push, 'служба push получила запрос');
    assert.equal(push.headers['content-encoding'], 'aes128gcm');
    assert.match(push.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=B/);
    assert.ok(!push.body.toString('latin1').includes('A-001'), 'служба push не видит текст');
    const message = author.decrypt(push.body);
    assert.equal(message.title, 'Голос сотрудника');
    assert.match(message.body, /A-001/);
    assert.match(message.url, /^\/#\/t\/\d+$/);
    const row = app.db.prepare("SELECT status, external_id FROM outbox WHERE channel = 'push' ORDER BY id DESC LIMIT 1").get();
    assert.deepEqual({ ...row }, { status: 'sent', external_id: 'устройств: 1' });
  });

  it('подписка, отозванная браузером (410), удаляется', async () => {
    reply = 410;
    const handler = await app.as('Руководитель закупок');
    await handler.post(`/api/tickets/${app.ticketId('A-001')}/comments`, { body: 'Уточните модель' });
    await app.delivery.idle();
    reply = 201;
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(app.userId('Сотрудник закупок')).n, 0);
    const row = app.db.prepare("SELECT status FROM outbox WHERE channel = 'push' ORDER BY id DESC LIMIT 1").get();
    assert.equal(row.status, 'skipped');
  });

  it('перенаправление от службы push не выполняется', async () => {
    reply = 307;
    const author = device();
    const emp = await app.as('Сотрудник закупок');
    await emp.post('/api/me/push', { endpoint: `${base}/send/redirect`, keys: author.keys });
    const handler = await app.as('Руководитель закупок');
    await handler.post(`/api/tickets/${app.ticketId('A-001')}/comments`, { body: 'Проверка перенаправления' });
    await app.delivery.idle();
    reply = 201;
    const row = app.db.prepare("SELECT status, error FROM outbox WHERE channel = 'push' ORDER BY id DESC LIMIT 1").get();
    assert.equal(row.status, 'pending');
    assert.match(row.error, /перенаправляет/);
    await emp.post('/api/me/push/remove', { endpoint: `${base}/send/redirect` });
  });

  it('без подписок push в журнал не пишется', async () => {
    const before = app.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE channel = 'push'").get().n;
    const handler = await app.as('Руководитель закупок');
    await handler.post(`/api/tickets/${app.ticketId('A-001')}/comments`, { body: 'Ещё вопрос' });
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE channel = 'push'").get().n, before);
  });
});
