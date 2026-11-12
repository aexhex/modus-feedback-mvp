// Push-уведомления на телефон и компьютер (стандарт Web Push) без внешних зависимостей — node:crypto.
// VAPID (RFC 8292): сервер подписывает запрос к службе push своим ключом P-256 (ES256).
// Шифрование (RFC 8291, aes128gcm): текст уведомления видит только браузер сотрудника, служба push — нет.
// Ключи сервера создаются при первом запуске и хранятся в настройках; их можно задать переменными
// VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (base64url), чтобы подписки переживали переустановку.
import {
  createECDH, createCipheriv, generateKeyPairSync, createPrivateKey, hkdfSync, randomBytes, sign,
} from 'node:crypto';
import { IntegrationError } from './clients.js';

const TIMEOUT_MS = 10_000;
const TTL_S = 24 * 3600;
const JWT_TTL_S = 12 * 3600;
const RECORD_SIZE = 4096;
const VAPID_KEY = 'vapid';

// Службы push браузеров. Адрес подписки присылает браузер, поэтому сервер ходит только к ним —
// иначе подпиской можно было бы заставить сервер слать запросы во внутреннюю сеть.
const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com',
  'notify.windows.com', 'push.apple.com', 'web.push.apple.com'];

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (text) => Buffer.from(String(text), 'base64url');

export function isPushEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  // Без порта и логина в адресе: только стандартный HTTPS службы push.
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  return PUSH_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

/** Ключи сервера: из переменных окружения или созданные один раз и сохранённые в настройках. */
export function vapidKeys(db, env = process.env) {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(VAPID_KEY);
  if (row) return JSON.parse(row.value);
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const keys = { publicKey: b64url(Buffer.concat([Buffer.from([4]), fromB64url(jwk.x), fromB64url(jwk.y)])), privateKey: jwk.d };
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(VAPID_KEY, JSON.stringify(keys));
  return keys;
}

function privateKeyObject({ publicKey, privateKey }) {
  const raw = fromB64url(publicKey);
  return createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33, 65)), d: privateKey },
    format: 'jwk',
  });
}

/** Заголовок Authorization для службы push: подписанный JWT на 12 часов для её адреса. */
export function vapidAuthorization(keys, endpoint, subject, nowS = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowS + JWT_TTL_S, sub: subject }));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: privateKeyObject(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

/** Шифрование по RFC 8291 (aes128gcm) для ключей подписки p256dh и auth. */
export function encryptPayload(subscriptionKeys, plaintext, { salt = randomBytes(16), serverEcdh } = {}) {
  const uaPublic = fromB64url(subscriptionKeys.p256dh);
  const authSecret = fromB64url(subscriptionKeys.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new IntegrationError('Push: неверные ключи подписки');
  const ecdh = serverEcdh ?? createECDH('prime256v1');
  if (!serverEcdh) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 — разделитель последней (единственной) записи.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/**
 * Отправка одного уведомления. @returns {'sent' | 'gone'} gone — подписка больше не действует (удалить).
 * checkHost: false — только для тестов с локальной службой push.
 */
export async function sendPush(subscription, payload, { keys, subject, checkHost = true }) {
  if (checkHost && !isPushEndpoint(subscription.endpoint)) throw new IntegrationError('Push: адрес подписки не принадлежит службе push');
  const body = encryptPayload(subscription, JSON.stringify(payload));
  let res;
  try {
    res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidAuthorization(keys, subscription.endpoint, subject),
        TTL: String(TTL_S), Urgency: 'normal',
        'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      },
      body,
      // Перенаправления не выполняются: разрешённый адрес не должен увести запрос в другое место.
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new IntegrationError(`Push: ${new URL(subscription.endpoint).host} — ${error.name === 'TimeoutError' ? 'нет ответа за 10 секунд' : 'служба недоступна'}`);
  }
  if (res.status === 404 || res.status === 410) return 'gone';
  if (res.status >= 300 && res.status < 400) throw new IntegrationError(`Push: ${new URL(subscription.endpoint).host} перенаправляет запрос — не отправлено`);
  if (res.status >= 400) throw new IntegrationError(`Push: ${new URL(subscription.endpoint).host} ответила ${res.status}`);
  return 'sent';
}
