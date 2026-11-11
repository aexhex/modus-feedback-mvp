// Вложения: base64 в JSON (без multipart-парсера), хранение на диске под случайным именем.
import { randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { ALLOWED_EXTENSIONS, LIMITS } from './config.js';
import { badRequest, forbidden, notFound } from './http.js';
import { canProcess } from './access.js';
import { getVisibleTicketRow } from './tickets-query.js';
import { addEvent } from './tickets-actions.js';

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function uploadAttachment(db, uploadsDir, user, ticketId, input, now) {
  const row = getVisibleTicketRow(db, user, ticketId);
  if (row.status === 'closed') throw badRequest('Обращение закрыто');
  // Читать обращение могут и наблюдатели, и все сотрудники (если оно в ленте), а прикладывать файлы —
  // только автор и обработчик: подписаться может любой читатель, поэтому подписка права не даёт.
  if (row.author_id !== user.id && !canProcess(user, row)) throw forbidden('Файлы прикладывают автор и ответственный');
  const name = basename(String(input.name || '')).slice(0, 120);
  const ext = extname(name).toLowerCase();
  if (!name || !ALLOWED_EXTENSIONS.includes(ext)) {
    throw badRequest(`Допустимые форматы: ${ALLOWED_EXTENSIONS.join(', ')}`);
  }
  const data = String(input.dataBase64 || '');
  if (!BASE64_RE.test(data)) throw badRequest('Файл передан в неверном формате');
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length === 0) throw badRequest('Файл пустой');
  if (buffer.length > LIMITS.attachmentBytes) throw badRequest('Файл больше 5 МБ');

  mkdirSync(uploadsDir, { recursive: true });
  const storedName = `${randomBytes(16).toString('hex')}${ext}`;
  writeFileSync(join(uploadsDir, storedName), buffer);
  const { lastInsertRowid } = db
    .prepare(
      'INSERT INTO attachments (ticket_id, uploader_id, original_name, stored_name, size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(row.id, user.id, name, storedName, buffer.length, now);
  addEvent(db, { ticketId: row.id, actorId: user.id, kind: 'attachment', body: `Прикреплён файл: ${name}`, at: now });
  return { id: Number(lastInsertRowid), name, size: buffer.length };
}

export function readAttachment(db, uploadsDir, user, attachmentId) {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(attachmentId));
  if (!att) throw notFound('Файл не найден');
  getVisibleTicketRow(db, user, att.ticket_id);
  try {
    return { name: att.original_name, body: readFileSync(join(uploadsDir, att.stored_name)) };
  } catch {
    throw notFound('Файл отсутствует в хранилище');
  }
}
