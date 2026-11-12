// Нагрузочная проверка: npm run loadtest [-- обращений сотрудников]  (по умолчанию 10 000 и 1 000).
// Временная база заполняется синтетическими сотрудниками, обращениями, историей, «у меня тоже» и
// уведомлениями; затем каждый тяжёлый запрос API выполняется несколько раз, печатается медиана в мс.
// Порог для экранов — 300 мс, для выгрузок и фоновых задач — 2 с. Ничего не отправляется наружу.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../src/app.js';
import { inTransaction } from '../src/db.js';
import { addBusinessHours } from '../src/config.js';
import { escalateOverdue } from '../src/escalation.js';
import { runRetention } from '../src/retention.js';

const TICKETS = Number(process.argv[2]) || 10_000;
const USERS = Number(process.argv[3]) || 1_000;
const RUNS = 5;
const SCREEN_MS = 300;
const HEAVY_MS = 2000;
const STATUSES = ['new', 'in_review', 'need_info', 'in_progress', 'implemented', 'rejected', 'closed'];
const WORDS = ['поставка', 'склад', 'договор', 'спецификация', 'приложение', 'согласование', 'инструкция', 'клиент',
  'счёт', 'оборудование', 'обучение', 'регламент', 'задержка', 'ошибка', 'отчёт', 'каталог', 'документ', 'сроки'];

const root = resolve(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'golos-load-'));
const NOW = '2026-11-11T09:00:00.000Z';
const { server, db } = createApp({
  dbPath: join(dir, 'load.db'), uploadsDir: join(dir, 'uploads'), publicDir: join(root, 'public'),
  now: () => NOW, logger: { error: () => {} }, escalationIntervalMs: 0, allowListLogin: true,
});

function fill() {
  const started = Date.now();
  const rnd = (n) => Math.floor(Math.random() * n);
  const pick = (list) => list[rnd(list.length)];
  const departments = Array.from({ length: 40 }, (_, i) => `Подразделение ${i + 1}`);
  const categories = db.prepare('SELECT id FROM categories').all().map((c) => c.id);
  inTransaction(db, () => {
    const addUser = db.prepare('INSERT INTO users (name, role, department, email) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < USERS; i += 1) {
      addUser.run(`Сотрудник нагрузки ${i + 1}`, i % 10 === 0 ? 'handler' : 'employee', pick(departments), `load${i}@load.example`);
    }
  });
  const users = db.prepare('SELECT id, role, department FROM users').all();
  const handlers = users.filter((u) => u.role !== 'employee');
  const base = Date.parse(NOW);
  inTransaction(db, () => {
    const addTicket = db.prepare(`INSERT INTO tickets (code, type, category_id, title, description, priority, status, author_id,
      is_anonymous, is_public, department, assignee_id, resolution, created_at, updated_at, first_response_due, due_at,
      first_response_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const addEvent = db.prepare("INSERT INTO events (ticket_id, actor_id, kind, body, created_at) VALUES (?, ?, 'comment', ?, ?)");
    const addSupport = db.prepare('INSERT OR IGNORE INTO supports (ticket_id, user_id, created_at) VALUES (?, ?, ?)');
    const addNote = db.prepare('INSERT INTO notifications (user_id, ticket_id, text, created_at) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < TICKETS; i += 1) {
      const author = pick(users);
      const created = new Date(base - rnd(365 * 24) * 3600_000).toISOString();
      const status = pick(STATUSES);
      const final = ['implemented', 'rejected', 'closed'].includes(status);
      const title = `${pick(WORDS)} ${pick(WORDS)} ${pick(WORDS)} — нагрузка ${i + 1}`;
      const { lastInsertRowid: id } = addTicket.run(
        `L-${String(i + 1).padStart(5, '0')}`, pick(['problem', 'idea']), pick(categories), title,
        `${title}. ${pick(WORDS)} ${pick(WORDS)} ${pick(WORDS)} ${pick(WORDS)}.`, pick(['low', 'medium', 'high']), status,
        author.id, rnd(10) === 0 ? 1 : 0, rnd(5) === 0 ? 1 : 0, author.department, pick(handlers).id,
        final ? 'Решение принято' : null, created, created, addBusinessHours(created, 72), addBusinessHours(created, 240),
        status === 'new' ? null : created, final ? created : null,
      );
      for (let e = 0; e < 3; e += 1) addEvent.run(id, author.id, `Комментарий ${e + 1}`, created);
      for (let s = 0; s < rnd(4); s += 1) addSupport.run(id, pick(users).id, created);
      addNote.run(author.id, id, `Обращение L-${i + 1}: новый статус`, created);
    }
  });
  return Date.now() - started;
}

async function login(name) {
  const base = `http://127.0.0.1:${server.address().port}`;
  const id = db.prepare('SELECT id FROM users WHERE name = ?').get(name).id;
  const res = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: id }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return (method, path, body) => fetch(base + path, {
    method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
}

async function measure(label, run, limit = SCREEN_MS) {
  const times = [];
  for (let i = 0; i < RUNS; i += 1) {
    const t0 = performance.now();
    const res = await run();
    if (res && res.status >= 400) throw new Error(`${label}: HTTP ${res.status} ${await res.text()}`);
    if (res?.arrayBuffer) await res.arrayBuffer();
    times.push(performance.now() - t0);
  }
  const median = times.sort((a, b) => a - b)[Math.floor(RUNS / 2)];
  const verdict = median <= limit ? 'ok' : 'МЕДЛЕННО';
  console.log(`${verdict.padEnd(9)} ${String(Math.round(median)).padStart(6)} мс  ${label}`);
  return { label, median, ok: median <= limit };
}

await new Promise((r) => server.listen(0, '127.0.0.1', r));
console.log(`Заполнение: ${TICKETS} обращений, ${USERS} сотрудников — ${fill()} мс\n`);
const director = await login('Директор по развитию');
const handler = await login('Ответственный за договоры');
const employee = await login('Сотрудник офиса');
const admin = await login('Администратор системы');
const someId = db.prepare('SELECT id FROM tickets ORDER BY id DESC LIMIT 1').get().id;
const regl = db.prepare("SELECT id FROM categories WHERE name = 'Регламенты'").get().id;

const results = [
  await measure('реестр: все обращения, первая страница', () => director('GET', '/api/tickets?scope=all')),
  await measure('реестр: поиск по тексту', () => director('GET', '/api/tickets?scope=all&q=договор')),
  await measure('реестр: отбор по статусу и периоду', () => director('GET', '/api/tickets?scope=all&status=in_progress&from=2026-06-01&to=2026-11-11')),
  await measure('реестр: только просроченные', () => director('GET', '/api/tickets?scope=all&overdue=1')),
  await measure('канбан (100 обращений)', () => director('GET', '/api/tickets?scope=all&notClosed=1&limit=100')),
  await measure('карточка обращения', () => director('GET', `/api/tickets/${someId}`)),
  await measure('главная руководителя', () => director('GET', '/api/home')),
  await measure('главная ответственного', () => handler('GET', '/api/home')),
  await measure('главная сотрудника', () => employee('GET', '/api/home')),
  await measure('показатели (аналитика)', () => director('GET', '/api/analytics')),
  await measure('отчёт за период', () => director('GET', '/api/report')),
  await measure('сводка недели', () => director('GET', '/api/digest')),
  await measure('идеи коллег', () => employee('GET', '/api/tickets?scope=feed')),
  await measure('итоги внедрения', () => employee('GET', '/api/board')),
  await measure('база решений', () => employee('GET', '/api/solutions?q=инструкция')),
  await measure('похожие при подаче', () => employee('GET', '/api/tickets/similar?q=задержка поставки на склад')),
  await measure('подача обращения', () => employee('POST', '/api/tickets', {
    type: 'problem', categoryId: regl, title: 'Задержка поставки на склад', description: 'Поставка задерживается уже неделю.',
  })),
  await measure('уведомления', () => employee('GET', '/api/notifications')),
  await measure('справочники (meta)', () => director('GET', '/api/meta')),
  await measure('пользователи (настройки)', () => admin('GET', '/api/admin/users')),
  await measure('экспорт в Excel (до 5000 строк)', () => director('GET', '/api/tickets/export?scope=all'), HEAVY_MS),
  await measure('эскалация просрочек (фон)', async () => { escalateOverdue(db, NOW); }, HEAVY_MS),
  await measure('обезличивание по сроку (фон)', async () => { runRetention(db, NOW); }, HEAVY_MS),
];

await new Promise((r) => server.close(r));
db.close();
rmSync(dir, { recursive: true, force: true });
const slow = results.filter((r) => !r.ok);
console.log(slow.length ? `\nМедленно: ${slow.map((r) => r.label).join('; ')}` : '\nВсе запросы укладываются в пороги.');
process.exitCode = slow.length ? 1 : 0;
