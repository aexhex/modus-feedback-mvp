// Оргструктура из Битрикс24 (ТЗ 1.2: «интеграция для назначения ответственных»).
// department.get + user.get → сотрудники, их подразделения и руководители подразделений.
// Сначала предпросмотр (ничего не меняет), затем применение — с повторной загрузкой с портала,
// чтобы применялось ровно то, что сейчас на портале, а не данные из браузера.
import { b24List, b24Call } from './clients.js';
import { inTransaction } from '../db.js';
import { HttpError } from '../http.js';
import { updateUser } from '../admin.js';
import { requeueUnlinked } from './delivery.js';
import { parseContacts } from '../contacts.js';

const REQUEUE_WINDOW_MS = 24 * 3600 * 1000;
// Если портал вернул подозрительно мало сотрудников (урезанные права вебхука, сбой), массово
// отключать людей нельзя: увольнения в этом случае не применяются.
const MAX_DISMISS_SHARE = 0.3;

const fullName = (u) => `${u.NAME ?? ''} ${u.LAST_NAME ?? ''}`.replace(/\s+/g, ' ').trim();
const isActive = (u) => u.ACTIVE === true || u.ACTIVE === 'Y' || u.ACTIVE === '1';

// Рабочие контакты из профиля портала. Неверное значение (например, телефон с буквами) пропускается,
// а не останавливает всю загрузку.
function portalContacts(u) {
  const pick = (field, value) => {
    try {
      return parseContacts({ [field]: value ?? '' })[field];
    } catch {
      return null;
    }
  };
  return {
    position: pick('position', u.WORK_POSITION),
    email: pick('email', u.EMAIL),
    phone: pick('phone', u.WORK_PHONE || u.PERSONAL_MOBILE),
  };
}

async function loadPortal(webhookUrl) {
  const [departments, users] = await Promise.all([b24List(webhookUrl, 'department.get'), b24List(webhookUrl, 'user.get')]);
  const deptName = new Map(departments.map((d) => [String(d.ID), String(d.NAME ?? '').trim()]));
  const heads = new Set(departments.map((d) => String(d.UF_HEAD ?? '')).filter(Boolean));
  const people = users
    .map((u) => ({
      b24Id: Number(u.ID),
      name: fullName(u).slice(0, 80),
      department: deptName.get(String((u.UF_DEPARTMENT ?? [])[0])) || 'Без подразделения',
      active: isActive(u),
      isHead: heads.has(String(u.ID)),
      contacts: portalContacts(u),
    }))
    .filter((p) => Number.isInteger(p.b24Id) && p.name.length >= 2);
  return { departments: departments.length, people };
}

// Сопоставление: сначала по ID Битрикс24, затем по ФИО среди ещё не связанных.
function plan(db, portal) {
  const locals = db.prepare('SELECT id, name, role, department, is_active, b24_id FROM users').all();
  const byB24 = new Map(locals.filter((u) => u.b24_id).map((u) => [u.b24_id, u]));
  const byName = new Map(locals.filter((u) => !u.b24_id).map((u) => [u.name, u]));
  const nameCount = new Map();
  for (const p of portal.people) nameCount.set(p.name, (nameCount.get(p.name) ?? 0) + 1);
  const seen = new Set();
  const skipped = new Map(); // id в системе → { пользователь, кандидаты с портала с тем же ФИО }
  const link = [];
  const contacts = [];
  const update = [];
  const create = [];
  for (const p of portal.people) {
    let local = byB24.get(p.b24Id);
    const named = local ? null : byName.get(p.name);
    if (named) {
      // Связь с порталом открывает вход через Битрикс24, а ФИО в профиле портала сотрудник может поменять сам.
      // Поэтому по ФИО не связываются администраторы (только ADMIN_B24_ID) и одинаковые ФИО на портале —
      // их администратор проверяет вручную.
      if (named.role === 'admin' || nameCount.get(p.name) > 1) {
        const entry = skipped.get(named.id) ?? { userId: named.id, name: named.name, role: named.role, candidates: [] };
        if (p.active) entry.candidates.push({ b24Id: p.b24Id, name: p.name, department: p.department });
        skipped.set(named.id, entry);
        continue;
      }
      local = named;
      // Совпадение по ФИО используется один раз.
      byName.delete(p.name);
    }
    if (!local) {
      if (p.active) create.push({ ...p, role: p.isHead ? 'handler' : 'employee' });
      continue;
    }
    seen.add(local.id);
    if (p.active) contacts.push({ id: local.id, ...p.contacts });
    if (!local.b24_id) link.push({ id: local.id, name: local.name, b24Id: p.b24Id });
    if (local.is_active && p.active && local.department !== p.department) {
      update.push({ id: local.id, name: local.name, from: local.department, to: p.department });
    }
    if (local.is_active && !p.active) update.push({ id: local.id, name: local.name, dismiss: true });
  }
  // Связанный сотрудник, которого больше нет на портале, тоже считается уволенным.
  for (const u of locals) {
    if (u.b24_id && u.is_active && !seen.has(u.id)) update.push({ id: u.id, name: u.name, dismiss: true });
  }
  const activeLocal = locals.filter((u) => u.is_active).length;
  const dismissCount = update.filter((u) => u.dismiss).length;
  const suspicious = portal.people.length === 0 || dismissCount > Math.max(2, activeLocal * MAX_DISMISS_SHARE);
  return { departments: portal.departments, portalUsers: portal.people.length, link, update, create, suspicious, skipped: [...skipped.values()], contacts };
}

export async function previewOrgSync(db, webhookUrl) {
  const p = plan(db, await loadPortal(webhookUrl));
  return {
    departments: p.departments,
    portalUsers: p.portalUsers,
    linked: p.link.map(({ name }) => name),
    created: p.create.map(({ name, department, role }) => ({ name, department, role })),
    moved: p.update.filter((u) => !u.dismiss).map(({ name, from, to }) => ({ name, from, to })),
    dismissed: p.update.filter((u) => u.dismiss).map(({ name }) => name),
    dismissBlocked: p.suspicious,
    notLinked: p.skipped,
  };
}

/**
 * Ручное связывание: администратор сам выбирает, какой сотрудник портала — этот пользователь системы
 * (одинаковые ФИО, администраторы, не совпавшее написание имени). Связь открывает вход через Битрикс24,
 * поэтому сотрудник портала проверяется на портале в момент связывания.
 */
export async function linkUser(db, webhookUrl, userId, b24Id, nowIso) {
  const id = Number(b24Id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Неверный ID сотрудника Битрикс24');
  const user = db.prepare('SELECT id, name, b24_id FROM users WHERE id = ? AND is_active = 1').get(Number(userId));
  if (!user) throw new HttpError(404, 'Пользователь не найден');
  if (user.b24_id) throw new HttpError(409, `${user.name}: уже связан с Битрикс24`);
  if (db.prepare('SELECT 1 FROM users WHERE b24_id = ?').get(id)) throw new HttpError(409, 'Этот сотрудник портала уже связан с другим пользователем');
  const found = (await b24Call(webhookUrl, 'user.get', { ID: id })).result;
  const portalUser = (Array.isArray(found) ? found : []).find((u) => Number(u.ID) === id);
  if (!portalUser || !isActive(portalUser)) throw new HttpError(404, 'На портале нет действующего сотрудника с таким ID');
  // Пока шёл запрос к порталу, связь мог поставить другой администратор или загрузка оргструктуры.
  let changes = 0;
  try {
    ({ changes } = db.prepare('UPDATE users SET b24_id = ? WHERE id = ? AND b24_id IS NULL').run(id, user.id));
  } catch (error) {
    if (!String(error.message).includes('UNIQUE')) throw error;
  }
  if (!changes) throw new HttpError(409, 'Связь уже изменилась — обновите предпросмотр');
  requeueUnlinked(db, new Date(new Date(nowIso).getTime() - REQUEUE_WINDOW_MS).toISOString());
  return { name: user.name, b24Id: id, portalName: fullName(portalUser) };
}

/**
 * Отвязка от портала — чтобы исправить ошибочное связывание: человек больше не входит через Битрикс24
 * под этой учётной записью, его открытые сессии закрываются сразу.
 */
export function unlinkUser(db, actor, userId) {
  const user = db.prepare('SELECT id, name, b24_id FROM users WHERE id = ?').get(Number(userId));
  if (!user) throw new HttpError(404, 'Пользователь не найден');
  if (!user.b24_id) throw new HttpError(409, `${user.name}: не связан с Битрикс24`);
  // Свою связь администратор не снимает: при входе только через портал он потерял бы доступ.
  if (user.id === actor.id) throw new HttpError(400, 'Свою связь с Битрикс24 отвязать нельзя');
  return inTransaction(db, () => {
    db.prepare('UPDATE users SET b24_id = NULL WHERE id = ?').run(user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    return { name: user.name, b24Id: user.b24_id };
  });
}

/** @returns {{ linked: number, created: number, moved: number, dismissed: number, warnings: string[] }} */
export async function applyOrgSync(db, webhookUrl, actor, nowIso) {
  const p = plan(db, await loadPortal(webhookUrl));
  return inTransaction(db, () => {
    const warnings = [];
    for (const l of p.link) db.prepare('UPDATE users SET b24_id = ? WHERE id = ?').run(l.b24Id, l.id);
    // Контакты из портала заполняют пустые и обновляют изменившиеся; пустое на портале не стирает введённое вручную.
    for (const c of p.contacts) {
      db.prepare(`UPDATE users SET position = COALESCE(?, position), email = COALESCE(?, email), phone = COALESCE(?, phone)
                  WHERE id = ?`).run(c.position, c.email, c.phone, c.id);
    }
    let created = 0;
    for (const c of p.create) {
      if (db.prepare('SELECT 1 FROM users WHERE name = ?').get(c.name)) {
        warnings.push(`${c.name}: в системе уже есть пользователь с таким именем — свяжите вручную`);
        continue;
      }
      db.prepare('INSERT INTO users (name, role, department, b24_id, position, email, phone) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(c.name, c.role, c.department, c.b24Id, c.contacts.position, c.contacts.email, c.contacts.phone);
      created += 1;
    }
    let moved = 0;
    let dismissed = 0;
    if (p.suspicious && p.update.some((u) => u.dismiss)) {
      warnings.push('С портала пришло подозрительно мало сотрудников — отключение уволенных пропущено, проверьте права вебхука');
    }
    for (const u of p.update.filter((x) => !(x.dismiss && p.suspicious))) {
      try {
        // Через updateUser: при увольнении его открытые обращения уходят следующему по правилу категории.
        updateUser(db, actor, u.id, u.dismiss ? { isActive: false } : { department: u.to }, nowIso);
        if (u.dismiss) dismissed += 1; else moved += 1;
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        warnings.push(`${u.name}: ${error.message}`);
      }
    }
    requeueUnlinked(db, new Date(new Date(nowIso).getTime() - REQUEUE_WINDOW_MS).toISOString());
    return { linked: p.link.length, created, moved, dismissed, warnings };
  });
}
