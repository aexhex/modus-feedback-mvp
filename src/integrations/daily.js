// Ежедневная синхронизация со справочниками компании.
// 1С УТ: контрагенты загружаются автоматически — это безопасно, старые обращения сохраняют клиента.
// Битрикс24: оргструктура только проверяется. Применение (в том числе отключение уволенных
// и передачу их обращений) подтверждает администратор — ему приходит уведомление со сводкой.
// Сессии уволенных на портале закрываются сразу: до решения администратора доступа у них нет,
// а войти снова через Битрикс24 уволенный не может.
import { createHash } from 'node:crypto';
import { syncCounterparties } from './onec.js';
import { previewOrgSync } from './b24-org.js';
import { notify } from '../notifications.js';
import { audit } from '../audit.js';

const PENDING_KEY = 'b24_org_pending';

function orgSummary(p) {
  return [
    p.created.length && `новых: ${p.created.length}`,
    p.moved.length && `переведено: ${p.moved.length}`,
    p.dismissed.length && `уволено: ${p.dismissed.length}`,
    p.linked.length && `к связыванию: ${p.linked.length}`,
  ].filter(Boolean).join(', ');
}

/** @returns {Promise<string|null>} сводка изменений, о которых сообщено, или null */
export async function checkOrgChanges(db, webhookUrl, nowIso) {
  const preview = await previewOrgSync(db, webhookUrl);
  let loggedOut = 0;
  for (const id of preview.dismissedIds) loggedOut += db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id).changes;
  if (loggedOut) audit(db, null, 'Сессии уволенных в Битрикс24 закрыты', `по ежедневной проверке: ${loggedOut}`, nowIso);
  const summary = orgSummary(preview);
  const signature = summary
    ? createHash('sha256').update(JSON.stringify([preview.created, preview.moved, preview.dismissed, preview.linked])).digest('hex')
    : '';
  const previous = db.prepare('SELECT value FROM settings WHERE key = ?').get(PENDING_KEY)?.value ?? '';
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(PENDING_KEY, signature);
  // Об одних и тех же изменениях сообщаем один раз, пока администратор их не применит.
  if (!summary || signature === previous) return null;
  const admins = db.prepare("SELECT id FROM users WHERE role = 'admin' AND is_active = 1").all().map((u) => u.id);
  notify(db, {
    userIds: admins, ticketId: null, actorId: null, now: nowIso,
    text: `В Битрикс24 изменилась оргструктура (${summary}) — проверьте и примените в «Настройках» → «Интеграции»`,
  });
  return summary;
}

/** Раз в сутки: контрагенты из 1С, проверка оргструктуры Битрикс24. Ошибка одной системы не мешает другой. */
export async function runDailySync({ db, config, endpoints, now, logger = console }) {
  const result = { counterparties: null, org: null };
  if (config.onec.mode !== 'off') {
    try {
      const { onec } = config;
      result.counterparties = await syncCounterparties(db, { url: endpoints().onec, user: onec.user, password: onec.password }, now());
      audit(db, null, 'Контрагенты загружены из 1С', `по расписанию: действующих ${result.counterparties.total}`, now());
    } catch (error) {
      logger.error('[daily 1c]', error);
    }
  }
  if (config.b24.mode !== 'off') {
    try {
      result.org = await checkOrgChanges(db, endpoints().b24, now());
    } catch (error) {
      logger.error('[daily b24 org]', error);
    }
  }
  return result;
}
