// Статусы задач Битрикс24: замыкают круг «обращение → задача → результат».
// Облачный портал присылает события только на адрес, доступный из интернета, поэтому статусы
// опрашиваются по расписанию (tasks.task.get). Когда задачу завершили, ответственный получает
// уведомление: подтвердить результат и зафиксировать итог обращения — это остаётся решением человека.
import { b24Call, IntegrationError } from './clients.js';
import { FINAL_STATUSES } from '../config.js';
import { addEvent } from '../tickets-actions.js';
import { notify } from '../notifications.js';
import { TASK_STATUSES } from './b24-task-status.js';

const DONE = new Set(['4', '5']); // «Ждёт контроля» — исполнитель уже сдал работу
const POLL_BATCH = 50;

export function recordTask(db, ticketId, taskId, nowIso) {
  db.prepare(`INSERT INTO b24_tasks (ticket_id, task_id, status, created_at) VALUES (?, ?, '2', ?)
              ON CONFLICT(ticket_id) DO UPDATE SET task_id = excluded.task_id`).run(ticketId, String(taskId), nowIso);
}

function onStatusChange(db, task, status, nowIso) {
  db.prepare('UPDATE b24_tasks SET status = ?, checked_at = ?, error = NULL WHERE ticket_id = ?').run(status, nowIso, task.id);
  const label = (TASK_STATUSES[status] ?? status).toLowerCase();
  const done = DONE.has(status) && !DONE.has(String(task.status));
  addEvent(db, {
    ticketId: task.id, actorId: null, kind: 'b24_task', at: nowIso,
    body: done
      ? `Задача в Битрикс24 №${task.task_id}: ${label} — подтвердите результат и зафиксируйте итог`
      : `Задача в Битрикс24 №${task.task_id}: ${label}`,
  });
  if (done) {
    notify(db, {
      userIds: [task.assignee_id], ticketId: task.id, actorId: null, now: nowIso,
      text: `Задача в Битрикс24 по ${task.code} выполнена — зафиксируйте итог обращения`,
    });
  }
}

/**
 * Проверяет статусы задач по открытым обращениям; ticketId — только по одному обращению.
 * @returns {Promise<{ checked: number, changed: number, errors: number }>}
 */
export async function pollTasks(db, webhookUrl, now, { ticketId = null } = {}) {
  const rows = db
    .prepare(
      `SELECT b.task_id, b.status, t.id, t.code, t.assignee_id FROM b24_tasks b JOIN tickets t ON t.id = b.ticket_id
       WHERE t.status NOT IN (${FINAL_STATUSES.map((s) => `'${s}'`).join(',')}) ${ticketId ? 'AND t.id = ?' : ''}
       ORDER BY b.checked_at IS NOT NULL, b.checked_at LIMIT ?`,
    )
    .all(...(ticketId ? [ticketId] : []), POLL_BATCH);
  const result = { checked: 0, changed: 0, errors: 0 };
  for (const task of rows) {
    try {
      const { result: answer } = await b24Call(webhookUrl, 'tasks.task.get', { taskId: task.task_id, select: ['ID', 'STATUS'] });
      const status = String(answer?.task?.status ?? '');
      if (!status) throw new IntegrationError('Битрикс24 tasks.task.get: в ответе нет статуса');
      result.checked += 1;
      if (status !== String(task.status)) {
        onStatusChange(db, task, status, now());
        result.changed += 1;
      } else {
        db.prepare('UPDATE b24_tasks SET checked_at = ?, error = NULL WHERE ticket_id = ?').run(now(), task.id);
      }
    } catch (error) {
      if (!(error instanceof IntegrationError)) throw error;
      // Задачу удалили на портале или нет прав — помечаем и идём дальше: остальные задачи проверяются.
      db.prepare('UPDATE b24_tasks SET checked_at = ?, error = ? WHERE ticket_id = ?').run(now(), error.message, task.id);
      result.errors += 1;
    }
  }
  return result;
}
