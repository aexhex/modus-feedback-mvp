// Статус задачи Битрикс24 для карточки обращения. Отдельный модуль без зависимостей:
// его читает tickets-query.js, а b24-tasks.js зависит от действий с обращениями.

// Коды статусов задачи в REST Битрикс24.
export const TASK_STATUSES = Object.freeze({
  1: 'Новая', 2: 'Ждёт выполнения', 3: 'Выполняется', 4: 'Ждёт контроля', 5: 'Завершена', 6: 'Отложена', 7: 'Отклонена',
});

export function taskInfo(db, ticketId) {
  const row = db.prepare('SELECT task_id, status, checked_at, error FROM b24_tasks WHERE ticket_id = ?').get(ticketId);
  if (!row) return null;
  return { taskId: row.task_id, statusLabel: TASK_STATUSES[row.status] ?? null, checkedAt: row.checked_at, error: row.error };
}
