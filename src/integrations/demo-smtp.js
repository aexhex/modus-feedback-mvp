// ДЕМО-ПОЧТА: учебный SMTP-сервер на этом же компьютере (только 127.0.0.1, только в демо-режиме).
// Система отправляет ему письма тем же SMTP-кодом, что и настоящему почтовому серверу компании,
// а полученные письма видны на странице демо-портала /demo-portal/mail/. Наружу письма не уходят.
import net from 'node:net';

const KEPT = 100; // ящик ограничен: страница демо-портала открыта без входа
const MAX_BYTES = 1024 * 1024; // одно письмо или незавершённая строка
const IDLE_MS = 30_000;
const MAX_CONNECTIONS = 20;

function decodeHeader(value = '') {
  return value.replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
}

export function parseMessage(raw) {
  const [head, ...rest] = raw.split(/\r?\n\r?\n/);
  const headers = {};
  for (const line of head.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0) headers[line.slice(0, idx).toLowerCase()] = line.slice(idx + 1).trim();
  }
  const body = rest.join('\n\n');
  const text = /base64/i.test(headers['content-transfer-encoding'] ?? '')
    ? Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
    : body;
  return { subject: decodeHeader(headers.subject), text, hiddenRecipient: headers['x-golos-hidden-recipient'] === '1' };
}

export function createDemoSmtp() {
  const messages = [];
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.setTimeout(IDLE_MS, () => socket.destroy());
    let size = 0;
    let buffer = '';
    let inData = false;
    let data = [];
    let envelope = { from: null, to: [] };
    const reply = (line) => socket.write(`${line}\r\n`);
    reply('220 demo-mail.local ESMTP учебный сервер');
    socket.on('data', (chunk) => {
      buffer += chunk;
      size += chunk.length;
      if (size > MAX_BYTES) {
        reply('552 письмо слишком большое');
        socket.destroy();
        return;
      }
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf('\n');
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push({ ...envelope, ...parseMessage(data.join('\r\n')), receivedAt: new Date().toISOString() });
            if (messages.length > KEPT) messages.splice(0, messages.length - KEPT);
            data = [];
            size = 0;
            envelope = { from: null, to: [] };
            reply('250 2.0.0 принято');
          } else {
            data.push(line.startsWith('..') ? line.slice(1) : line);
          }
          continue;
        }
        const [verb] = line.split(' ');
        switch (verb.toUpperCase()) {
          case 'EHLO': case 'HELO': reply('250-demo-mail.local'); reply('250 8BITMIME'); break;
          case 'MAIL': envelope.from = /<([^>]*)>/.exec(line)?.[1] ?? null; reply('250 2.1.0 ok'); break;
          case 'RCPT': envelope.to.push(/<([^>]*)>/.exec(line)?.[1] ?? ''); reply('250 2.1.5 ok'); break;
          case 'DATA': inData = true; reply('354 конец письма — строка с одной точкой'); break;
          case 'RSET': envelope = { from: null, to: [] }; reply('250 ok'); break;
          case 'NOOP': reply('250 ok'); break;
          case 'QUIT': reply('221 до свидания'); socket.end(); break;
          default: reply('502 команда не поддерживается');
        }
      }
    });
    socket.on('error', () => {});
  });
  server.maxConnections = MAX_CONNECTIONS;
  return {
    messages,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(() => resolve())),
    port: () => server.address()?.port ?? null,
  };
}
