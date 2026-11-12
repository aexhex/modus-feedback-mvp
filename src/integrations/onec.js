// 1С УТ (ТЗ 1.2: «последующий анализ обращений»).
// 1С → система: справочник контрагентов через OData — обращение можно связать с клиентом.
// Система → 1С: выгрузка обращений по токену — 1С забирает её регламентным заданием.
import { timingSafeEqual, createHash } from 'node:crypto';
import { onecGet } from './clients.js';
import { inTransaction } from '../db.js';
import { badRequest, forbidden, notFound } from '../http.js';
import { STATUSES, TYPES } from '../config.js';

const MAX_COUNTERPARTIES = 20_000;
const EXPORT_LIMIT = 5000;
const SELECT = 'Ref_Key,Code,Description,ИНН,DeletionMark';

/** @returns {{ total: number, added: number, updated: number, deactivated: number }} */
export async function syncCounterparties(db, onec, nowIso) {
  const rows = await onecGet(onec, 'Catalog_Контрагенты', { $select: SELECT });
  if (rows.length > MAX_COUNTERPARTIES) throw badRequest(`1С вернула больше ${MAX_COUNTERPARTIES} контрагентов`);
  return inTransaction(db, () => {
    const result = { total: 0, added: 0, updated: 0, deactivated: 0 };
    const seen = new Set();
    for (const r of rows) {
      const ref = String(r.Ref_Key ?? '');
      const name = String(r.Description ?? '').trim().slice(0, 200);
      if (!ref || !name) continue;
      seen.add(ref);
      const active = r.DeletionMark ? 0 : 1;
      const existing = db.prepare('SELECT id, is_active FROM counterparties WHERE ref_key = ?').get(ref);
      if (existing) {
        db.prepare('UPDATE counterparties SET code = ?, name = ?, inn = ?, is_active = ?, synced_at = ? WHERE id = ?')
          .run(r.Code ?? null, name, r.ИНН ?? null, active, nowIso, existing.id);
        result.updated += 1;
        if (existing.is_active && !active) result.deactivated += 1;
      } else {
        db.prepare('INSERT INTO counterparties (ref_key, code, name, inn, is_active, synced_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(ref, r.Code ?? null, name, r.ИНН ?? null, active, nowIso);
        result.added += 1;
      }
      if (active) result.total += 1;
    }
    // Контрагент, удалённый из 1С, остаётся у старых обращений, но больше не предлагается.
    for (const c of db.prepare('SELECT id, ref_key FROM counterparties WHERE is_active = 1').all()) {
      if (!seen.has(c.ref_key)) {
        db.prepare('UPDATE counterparties SET is_active = 0 WHERE id = ?').run(c.id);
        result.deactivated += 1;
      }
    }
    return result;
  });
}

export function listCounterparties(db) {
  return db.prepare('SELECT id, name, inn FROM counterparties WHERE is_active = 1 ORDER BY name').all();
}

export function counterpartiesCount(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM counterparties WHERE is_active = 1').get().n;
}

/** Проверка выбранного клиента при подаче обращения. */
export function validCounterpartyId(db, value) {
  if (value === undefined || value === null || value === '') return null;
  const row = db.prepare('SELECT id FROM counterparties WHERE id = ? AND is_active = 1').get(Number(value));
  if (!row) throw badRequest('Клиент не найден в справочнике 1С');
  return row.id;
}

const digest = (s) => createHash('sha256').update(String(s)).digest();

export function checkExportToken(expected, header) {
  if (!expected) throw notFound('Выгрузка для 1С не настроена');
  const given = /^Bearer (.+)$/.exec(header ?? '')?.[1];
  // Сравнение хешей одинаковой длины за постоянное время — длина и содержимое токена не утекают.
  if (!given || !timingSafeEqual(digest(given), digest(expected))) throw forbidden('Неверный токен выгрузки');
}

/**
 * Обращения для анализа в 1С. Без текста и без автора: только классификация, сроки и клиент.
 * У анонимных обращений подразделение скрыто так же, как в интерфейсе.
 */
export function exportForOnec(db, query = {}) {
  const since = typeof query.since === 'string' && !Number.isNaN(Date.parse(query.since)) ? new Date(query.since).toISOString() : null;
  const rows = db
    .prepare(
      `SELECT t.code, t.type, t.status, t.priority, t.is_anonymous, t.department, t.created_at, t.updated_at,
              t.first_response_at, t.resolved_at, t.due_at, c.name AS category,
              k.ref_key AS cp_ref, k.code AS cp_code, k.inn AS cp_inn, k.name AS cp_name,
              (SELECT COUNT(*) FROM supports s WHERE s.ticket_id = t.id) AS supporters
       FROM tickets t JOIN categories c ON c.id = t.category_id
       LEFT JOIN counterparties k ON k.id = t.counterparty_id
       WHERE t.duplicate_of IS NULL ${since ? 'AND t.updated_at >= ?' : ''}
       ORDER BY t.updated_at, t.id LIMIT ?`,
    )
    .all(...(since ? [since] : []), EXPORT_LIMIT);
  return rows.map((r) => ({
    code: r.code,
    type: r.type,
    typeLabel: TYPES[r.type],
    category: r.category,
    department: r.is_anonymous ? null : r.department,
    status: r.status,
    statusLabel: STATUSES[r.status],
    priority: r.priority,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    firstResponseAt: r.first_response_at,
    resolvedAt: r.resolved_at,
    dueAt: r.due_at,
    supporters: r.supporters,
    counterparty: r.cp_ref ? { refKey: r.cp_ref, code: r.cp_code, inn: r.cp_inn, name: r.cp_name } : null,
  }));
}
