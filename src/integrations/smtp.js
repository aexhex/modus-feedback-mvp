// Отправка письма по SMTP без внешних зависимостей: node:net / node:tls.
// Шифрование: SMTP_SECURE=1 — TLS сразу (порт 465), иначе STARTTLS, если сервер его предлагает.
// Пароль по незашифрованному соединению не отправляется. Сертификат сервера проверяется.
import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import { IntegrationError } from './clients.js';

const TIMEOUT_MS = 15_000;
const HELO_NAME = 'golos-sotrudnika';
const ADDRESS_RE = /^[^\s@<>"',;:\\]+@[^\s@<>"',;:\\]+\.[^\s@<>"',;:\\]{2,}$/;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
// Адреса в ответах сервера (например, «550 <a@b> unknown») не попадают в журнал: по ним можно узнать
// получателя письма об анонимном обращении.
const hideAddresses = (text) => text.replace(/<?[^\s<>@]+@[^\s<>@]+>?/g, '[адрес]');

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
// Заголовок в UTF-8 (RFC 2047). Переводы строк убираются — иначе можно было бы дописать свой заголовок.
const encodeHeader = (text) => `=?UTF-8?B?${b64(String(text).replace(/[\r\n]+/g, ' '))}?=`;
const wrap = (text, width = 76) => text.match(new RegExp(`.{1,${width}}`, 'g'))?.join('\r\n') ?? '';

function address(value, field) {
  const text = String(value ?? '').trim();
  if (!ADDRESS_RE.test(text)) throw new IntegrationError(`Почта: неверный адрес (${field})`);
  return text;
}

export function buildMessage({ from, fromName, to, subject, text, hiddenRecipient = false, now = new Date() }) {
  const domain = from.split('@')[1];
  return [
    // Служебная пометка для демо-почты: письмо об анонимном обращении — адрес получателя на странице не показывается.
    ...(hiddenRecipient ? ['X-Golos-Hidden-Recipient: 1'] : []),
    `From: ${fromName ? `${encodeHeader(fromName)} ` : ''}<${from}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(b64(text)),
  ].join('\r\n');
}

// Ответы сервера построчно: многострочный ответ «250-…» заканчивается строкой «250 …».
function replies(socket) {
  let buffer = '';
  let lines = [];
  let waiter = null;
  let failure = null;
  const settle = () => {
    if (!waiter) return;
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), text: lines.join('\n') };
        lines = [];
        const w = waiter;
        waiter = null;
        w.resolve(reply);
        return;
      }
      idx = buffer.indexOf('\n');
    }
    if (failure) {
      const w = waiter;
      waiter = null;
      w.reject(failure);
    }
  };
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => { buffer += chunk; settle(); });
  socket.on('error', (error) => { failure = new IntegrationError(`Почта: ${error.message}`); settle(); });
  socket.on('close', () => { failure ??= new IntegrationError('Почта: сервер закрыл соединение'); settle(); });
  return () => new Promise((resolve, reject) => { waiter = { resolve, reject }; settle(); });
}

function connect(server) {
  return new Promise((resolve, reject) => {
    const socket = server.secure
      ? tls.connect({ host: server.host, port: server.port, servername: server.host })
      : net.connect({ host: server.host, port: server.port });
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error('нет ответа за 15 секунд')));
    socket.once(server.secure ? 'secureConnect' : 'connect', () => resolve(socket));
    socket.once('error', (error) => reject(new IntegrationError(`Почта: ${server.host} — ${error.message}`)));
  });
}

function startTls(socket, server) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: server.host });
    secure.setTimeout(TIMEOUT_MS, () => secure.destroy(new Error('нет ответа за 15 секунд')));
    secure.once('secureConnect', () => resolve(secure));
    secure.once('error', (error) => reject(new IntegrationError(`Почта: STARTTLS — ${error.message}`)));
  });
}

/**
 * @param {{ host: string, port: number, secure?: boolean, user?: string, password?: string }} server
 * @param {{ from: string, fromName?: string, to: string, subject: string, text: string }} mail
 * @returns {Promise<string>} ответ сервера на письмо (обычно с его номером в очереди)
 */
export async function sendMail(server, mail) {
  const from = address(mail.from, 'отправитель');
  const to = address(mail.to, 'получатель');
  let socket = await connect(server);
  let next = replies(socket);
  let encrypted = Boolean(server.secure);
  const command = async (line, expected) => {
    if (line !== null) socket.write(`${line}\r\n`);
    const reply = await next();
    if (!expected.includes(reply.code)) {
      const step = line === null ? 'приветствие' : line.split(' ')[0];
      throw new IntegrationError(`Почта: ${step} — ${hideAddresses(reply.text.replace(/\s+/g, ' ')).slice(0, 200)}`);
    }
    return reply;
  };
  try {
    await command(null, [220]);
    let ehlo = await command(`EHLO ${HELO_NAME}`, [250]);
    if (!encrypted && /^\d{3}[ -]STARTTLS\b/im.test(ehlo.text)) {
      await command('STARTTLS', [220]);
      socket.removeAllListeners('data');
      socket = await startTls(socket, server);
      next = replies(socket);
      encrypted = true;
      ehlo = await command(`EHLO ${HELO_NAME}`, [250]);
    }
    // Без шифрования письмо (текст уведомления) не уходит: перехватчик мог убрать STARTTLS из ответа.
    // Исключения — сервер на этом же компьютере и явное разрешение SMTP_ALLOW_PLAIN=1 (внутренний релей).
    if (!encrypted && !LOOPBACK.has(server.host) && !server.allowPlain) {
      throw new IntegrationError('Почта: сервер не поддерживает шифрование — письмо не отправлено');
    }
    if (server.user) {
      if (!encrypted) throw new IntegrationError('Почта: сервер не поддерживает шифрование — пароль не отправлен');
      await command(`AUTH PLAIN ${b64(`\u0000${server.user}\u0000${server.password ?? ''}`)}`, [235]);
    }
    await command(`MAIL FROM:<${from}>`, [250]);
    await command(`RCPT TO:<${to}>`, [250, 251]);
    await command('DATA', [354]);
    // Тело в base64: строк из одной точки в нём не бывает, экранировать нечего.
    const accepted = await command(`${buildMessage({ ...mail, from, to })}\r\n.`, [250]);
    socket.write('QUIT\r\n');
    return accepted.text.slice(4, 200);
  } finally {
    socket.end();
    setTimeout(() => socket.destroy(), 1000).unref();
  }
}
