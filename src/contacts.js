// Рабочие контакты сотрудника: должность, почта, телефон. Только рабочие — личные данные системе не нужны.
// Источник — Битрикс24 (загрузка оргструктуры) или администратор вручную. Почта нужна и для писем-уведомлений.
// Видимость: контакты ответственного видят все, кто видит обращение (чтобы автор мог с ним связаться);
// контакты автора — только те, кто обращение рассматривает, и никогда — у анонимного обращения.
import { badRequest } from './http.js';

const EMAIL_RE = /^[^\s@<>"',;:\\]+@[^\s@<>"',;:\\]+\.[^\s@<>"',;:\\]{2,}$/;
const PHONE_RE = /^\+?[0-9][0-9 ()-]{4,28}[0-9]$/;
const LIMITS = { position: 80, email: 120, phone: 30 };

function clean(value, field, label) {
  if (value === undefined) return undefined;
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text.length > LIMITS[field]) throw badRequest(`${label}: не длиннее ${LIMITS[field]} символов`);
  if (field === 'email' && !EMAIL_RE.test(text)) throw badRequest('Почта: неверный адрес');
  if (field === 'phone' && !PHONE_RE.test(text)) throw badRequest('Телефон: цифры, пробелы, скобки и дефисы, можно с «+»');
  return field === 'email' ? text.toLowerCase() : text;
}

/** Только переданные поля; пустая строка очищает поле. */
export function parseContacts(input = {}) {
  return {
    position: clean(input.position, 'position', 'Должность'),
    email: clean(input.email, 'email', 'Почта'),
    phone: clean(input.phone, 'phone', 'Телефон'),
  };
}

/** @returns {string[] | null} изменённые поля — для журнала действий; null — пользователя нет */
export function setContacts(db, userId, input) {
  const current = db.prepare('SELECT id, position, email, phone FROM users WHERE id = ?').get(Number(userId));
  if (!current) return null;
  const parsed = parseContacts(input);
  const next = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, v === undefined ? current[k] : v]));
  db.prepare('UPDATE users SET position = ?, email = ?, phone = ? WHERE id = ?').run(next.position, next.email, next.phone, current.id);
  return Object.keys(next).filter((k) => next[k] !== current[k]);
}

export function contactsOf(db, userId) {
  if (!userId) return null;
  const row = db.prepare('SELECT position, email, phone FROM users WHERE id = ?').get(userId);
  if (!row || (!row.position && !row.email && !row.phone)) return null;
  return { position: row.position, email: row.email, phone: row.phone };
}

// Синтетические контакты демо-данных: домен .example зарезервирован, номер с кодом 000 не существует.
export const demoContacts = (index) => ({
  email: `employee${index + 1}@modus-demo.example`,
  phone: `+7 (000) 000-${String(Math.floor((index + 1) / 100)).padStart(2, '0')}-${String((index + 1) % 100).padStart(2, '0')}`,
});
