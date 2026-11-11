// Шаблоны ответов для обработчиков: хранятся в базе, редактируются администратором.
import { REPLY_TEMPLATES } from './config.js';
import { badRequest, notFound } from './http.js';

const FIELDS = Object.freeze({ comment: 'Комментарий', resolution: 'Результат' });
const TITLE_MAX = 60;
const TEXT_MAX = 3000;

const SEEDED_KEY = 'templates_seeded';

// Заготовки из config.js добавляются один раз. Отметка в settings отличает «ещё не заполняли»
// от «администратор удалил все шаблоны» — во втором случае список остаётся пустым.
export function seedTemplates(db) {
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(SEEDED_KEY)) return;
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM reply_templates').get();
  if (n === 0) {
    const insert = db.prepare('INSERT INTO reply_templates (title, field, text) VALUES (?, ?, ?)');
    for (const t of REPLY_TEMPLATES) insert.run(t.title, t.field, t.text);
  }
  db.prepare("INSERT INTO settings (key, value) VALUES (?, '1')").run(SEEDED_KEY);
}

export function listTemplates(db) {
  return db.prepare('SELECT id, title, field, text FROM reply_templates ORDER BY field, title').all();
}

function validate(input) {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (title.length < 2 || title.length > TITLE_MAX) throw badRequest(`Название шаблона: от 2 до ${TITLE_MAX} символов`);
  if (!Object.hasOwn(FIELDS, input.field)) throw badRequest('Укажите, куда подставлять шаблон: в комментарий или в результат');
  if (text.length < 5 || text.length > TEXT_MAX) throw badRequest(`Текст шаблона: от 5 до ${TEXT_MAX} символов`);
  return { title, field: input.field, text };
}

export function createTemplate(db, input) {
  const t = validate(input);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO reply_templates (title, field, text) VALUES (?, ?, ?)')
    .run(t.title, t.field, t.text);
  return { id: Number(lastInsertRowid), ...t };
}

export function updateTemplate(db, id, input) {
  const t = validate(input);
  const { changes } = db
    .prepare('UPDATE reply_templates SET title = ?, field = ?, text = ? WHERE id = ?')
    .run(t.title, t.field, t.text, Number(id));
  if (changes === 0) throw notFound('Шаблон не найден');
  return t;
}

export function deleteTemplate(db, id) {
  const row = db.prepare('SELECT title FROM reply_templates WHERE id = ?').get(Number(id));
  if (!row) throw notFound('Шаблон не найден');
  db.prepare('DELETE FROM reply_templates WHERE id = ?').run(Number(id));
  return row.title;
}
