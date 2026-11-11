// Опросы сотрудников: вопросы с оценкой 1–5 и открытые. Ответы показываются только сводно,
// без имён, и только когда ответивших не меньше порога анонимности.
import { canSeeAnalytics } from './access.js';
import { badRequest, forbidden, notFound } from './http.js';
import { inTransaction } from './db.js';

export const ANONYMITY_THRESHOLD = 3;
const TITLE_MAX = 120;
const QUESTION_MAX = 300;
const ANSWER_MAX = 1000;
const QUESTIONS_MAX = 20;
const SCALE = [1, 2, 3, 4, 5];

function questionList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest(`${field}: ожидается список вопросов`);
  return value.map((q) => (typeof q === 'string' ? q.trim() : '')).filter(Boolean).map((q) => {
    if (q.length > QUESTION_MAX) throw badRequest(`Вопрос длиннее ${QUESTION_MAX} символов`);
    return q;
  });
}

export function createSurvey(db, user, input, now) {
  if (!canSeeAnalytics(user)) throw forbidden('Опросы создаёт руководитель или администратор');
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title.length < 5 || title.length > TITLE_MAX) throw badRequest(`Название опроса: от 5 до ${TITLE_MAX} символов`);
  const description = typeof input.description === 'string' ? input.description.trim().slice(0, 500) : '';
  const scale = questionList(input.scaleQuestions, 'Вопросы с оценкой');
  const open = questionList(input.textQuestions, 'Открытые вопросы');
  const total = scale.length + open.length;
  if (total === 0) throw badRequest('Добавьте хотя бы один вопрос');
  if (total > QUESTIONS_MAX) throw badRequest(`Не больше ${QUESTIONS_MAX} вопросов`);
  return inTransaction(db, () => {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO surveys (title, description, created_by, created_at) VALUES (?, ?, ?, ?)')
      .run(title, description, user.id, now);
    const surveyId = Number(lastInsertRowid);
    const insert = db.prepare('INSERT INTO survey_questions (survey_id, text, kind, position) VALUES (?, ?, ?, ?)');
    [...scale.map((q) => [q, 'scale']), ...open.map((q) => [q, 'text'])]
      .forEach(([text, kind], index) => insert.run(surveyId, text, kind, index));
    return surveyId;
  });
}

const respondents = (db, surveyId) => db
  .prepare(
    `SELECT COUNT(DISTINCT a.user_id) AS n FROM survey_answers a
     JOIN survey_questions q ON q.id = a.question_id WHERE q.survey_id = ?`,
  )
  .get(surveyId).n;

const hasAnswered = (db, surveyId, userId) => Boolean(db
  .prepare(
    `SELECT 1 FROM survey_answers a JOIN survey_questions q ON q.id = a.question_id
     WHERE q.survey_id = ? AND a.user_id = ? LIMIT 1`,
  )
  .get(surveyId, userId));

// Сотрудники видят только открытые опросы; руководитель — также закрытые (ради результатов).
export function listSurveys(db, user) {
  const oversight = canSeeAnalytics(user);
  return db
    .prepare(`SELECT id, title, description, is_open, created_at FROM surveys ${oversight ? '' : 'WHERE is_open = 1'} ORDER BY id DESC`)
    .all()
    .map((s) => ({
      id: s.id, title: s.title, description: s.description, isOpen: Boolean(s.is_open), createdAt: s.created_at,
      answered: hasAnswered(db, s.id, user.id),
      respondents: oversight ? respondents(db, s.id) : undefined,
    }));
}

function getSurveyRow(db, id) {
  const row = db.prepare('SELECT * FROM surveys WHERE id = ?').get(Number(id));
  if (!row) throw notFound('Опрос не найден');
  return row;
}

const questionsOf = (db, surveyId) => db
  .prepare('SELECT id, text, kind FROM survey_questions WHERE survey_id = ? ORDER BY position')
  .all(surveyId);

export function getSurvey(db, user, id) {
  const row = getSurveyRow(db, id);
  if (!row.is_open && !canSeeAnalytics(user)) throw notFound('Опрос не найден');
  return {
    id: row.id, title: row.title, description: row.description, isOpen: Boolean(row.is_open),
    answered: hasAnswered(db, row.id, user.id),
    questions: questionsOf(db, row.id),
  };
}

export function submitAnswers(db, user, id, input, now) {
  const row = getSurveyRow(db, id);
  if (!row.is_open) throw badRequest('Опрос закрыт');
  if (hasAnswered(db, row.id, user.id)) throw badRequest('Вы уже прошли этот опрос');
  const answers = input.answers && typeof input.answers === 'object' && !Array.isArray(input.answers) ? input.answers : {};
  const values = questionsOf(db, row.id).map((q) => {
    const raw = answers[q.id];
    if (q.kind === 'scale') {
      if (!SCALE.includes(Number(raw))) throw badRequest(`Оцените от 1 до 5: «${q.text}»`);
      return [q.id, String(Number(raw))];
    }
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text.length > ANSWER_MAX) throw badRequest(`Ответ длиннее ${ANSWER_MAX} символов`);
    return [q.id, text];
  });
  inTransaction(db, () => {
    const insert = db.prepare('INSERT INTO survey_answers (question_id, user_id, value, created_at) VALUES (?, ?, ?, ?)');
    for (const [questionId, value] of values) insert.run(questionId, user.id, value, now);
  });
}

export function setSurveyOpen(db, user, id, input) {
  if (!canSeeAnalytics(user)) throw forbidden();
  if (typeof input.isOpen !== 'boolean') throw badRequest('Ожидается isOpen: true/false');
  const row = getSurveyRow(db, id);
  // Если бы опрос можно было открыть заново, сравнение результатов «до» и «после» выдало бы новые ответы.
  if (input.isOpen && !row.is_open) throw badRequest('Закрытый опрос нельзя открыть заново — так сохраняется анонимность ответов');
  db.prepare('UPDATE surveys SET is_open = ? WHERE id = ?').run(input.isOpen ? 1 : 0, row.id);
  return row.title;
}

export function surveyResults(db, user, id) {
  if (!canSeeAnalytics(user)) throw forbidden();
  const row = getSurveyRow(db, id);
  const count = respondents(db, row.id);
  const base = { id: row.id, title: row.title, isOpen: Boolean(row.is_open), respondents: count, threshold: ANONYMITY_THRESHOLD };
  // Пока опрос открыт, результаты не показываются: иначе, сравнив их до и после нового ответа, можно вычислить отвечавшего.
  if (row.is_open) return { ...base, hidden: true, reason: 'open', questions: [] };
  // При малом числе ответов автора тоже можно вычислить.
  if (count < ANONYMITY_THRESHOLD) return { ...base, hidden: true, reason: 'few', questions: [] };
  const questions = questionsOf(db, row.id).map((q) => {
    const values = db.prepare('SELECT value FROM survey_answers WHERE question_id = ?').all(q.id).map((r) => r.value);
    if (q.kind === 'scale') {
      const numbers = values.map(Number);
      const average = Math.round((numbers.reduce((sum, v) => sum + v, 0) / numbers.length) * 10) / 10;
      return { ...q, average, distribution: SCALE.map((v) => ({ value: v, count: numbers.filter((n) => n === v).length })) };
    }
    // Порог действует и для текстов: единственный непустой ответ выдавал бы автора.
    // Тексты сортируются по алфавиту, чтобы порядок не выдавал очерёдность ответивших.
    const filled = values.filter(Boolean);
    const enough = filled.length >= ANONYMITY_THRESHOLD;
    return { ...q, answers: enough ? filled.sort((a, b) => a.localeCompare(b, 'ru')) : [], answersHidden: filled.length > 0 && !enough };
  });
  return { ...base, hidden: false, questions };
}

export function openSurveysFor(db, userId) {
  return db.prepare('SELECT id FROM surveys WHERE is_open = 1').all().filter((s) => !hasAnswered(db, s.id, userId)).length;
}
