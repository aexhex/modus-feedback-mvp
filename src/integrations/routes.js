// API интеграций с Битрикс24 и 1С УТ. Управление — только администратору; выгрузку для 1С
// забирает сама 1С по токену (без сессии пользователя).
import { HttpError, badRequest, notFound, forbidden } from '../http.js';
import { IntegrationError } from './clients.js';
import { describeConfig } from './config.js';
import { previewOrgSync, applyOrgSync, linkUser, unlinkUser } from './b24-org.js';
import { syncCounterparties, listCounterparties, counterpartiesCount, checkExportToken, exportForOnec } from './onec.js';
import { retryOutbox, outboxStats } from './delivery.js';
import { b24Call } from './clients.js';
import { canProcess } from '../access.js';
import { getVisibleTicketRow, getTicketDetail } from '../tickets-query.js';

// Ошибка внешней системы — не ошибка нашего сервера: 502 с понятным текстом.
async function external(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof IntegrationError) throw new HttpError(502, error.message);
    throw error;
  }
}

function b24Url(ctx) {
  if (ctx.integrations.config.b24.mode === 'off') throw badRequest('Битрикс24 не подключён: задайте переменную B24_WEBHOOK_URL');
  return ctx.integrations.endpoints().b24;
}

function onecConnection(ctx) {
  const { onec } = ctx.integrations.config;
  if (onec.mode === 'off') throw badRequest('1С не подключена: задайте переменную ONEC_ODATA_URL');
  return { url: ctx.integrations.endpoints().onec, user: onec.user, password: onec.password };
}

export function registerIntegrationRoutes({ add, admin, PUBLIC, MUTATE }) {
  admin('GET', '/api/admin/integrations', ({ ctx }) => ({
    ...describeConfig(ctx.integrations.config),
    outbox: outboxStats(ctx.db),
    mailOutbox: outboxStats(ctx.db, 'email'),
    linkedUsers: ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE b24_id IS NOT NULL AND is_active = 1').get().n,
    counterparties: counterpartiesCount(ctx.db),
    exportUrl: `${ctx.integrations.endpoints().publicUrl}/api/integrations/1c/tickets`,
  }));

  admin('POST', '/api/admin/integrations/b24/org-preview', ({ ctx }) =>
    external(() => previewOrgSync(ctx.db, b24Url(ctx))), MUTATE);

  admin('POST', '/api/admin/integrations/b24/org-apply', async ({ ctx, user, log }) => {
    const result = await external(() => applyOrgSync(ctx.db, b24Url(ctx), user, ctx.now()));
    log('Оргструктура загружена из Битрикс24',
      `связано: ${result.linked}, добавлено: ${result.created}, переведено: ${result.moved}, отключено: ${result.dismissed}`);
    return result;
  }, MUTATE);

  admin('POST', '/api/admin/integrations/b24/link', async ({ ctx, body, log }) => {
    const result = await external(() => linkUser(ctx.db, b24Url(ctx), body.userId, body.b24Id, ctx.now()));
    log('Сотрудник связан с Битрикс24 вручную', `${result.name} → ${result.portalName} (ID ${result.b24Id})`);
    return result;
  }, MUTATE);

  admin('POST', '/api/admin/integrations/b24/unlink', ({ ctx, user, body, log }) => {
    const result = unlinkUser(ctx.db, user, body.userId);
    log('Сотрудник отвязан от Битрикс24', `${result.name} (ID ${result.b24Id})`);
    return result;
  }, MUTATE);

  admin('POST', '/api/admin/integrations/1c/counterparties', async ({ ctx, log }) => {
    const result = await external(() => syncCounterparties(ctx.db, onecConnection(ctx), ctx.now()));
    log('Контрагенты загружены из 1С', `действующих: ${result.total}, новых: ${result.added}, снято: ${result.deactivated}`);
    return result;
  }, MUTATE);

  admin('POST', '/api/admin/integrations/b24/tasks-check', ({ ctx }) => {
    b24Url(ctx);
    return external(() => ctx.integrations.checkTasks());
  }, MUTATE);

  // Только демо-режим: «исполнитель» завершает задачу на демо-портале, чтобы показать замкнутый круг.
  // На настоящем портале задачу завершает сам исполнитель в Битрикс24.
  add('POST', '/api/tickets/:id/b24-task/demo-complete', async ({ ctx, user, params }) => {
    if (ctx.integrations.config.b24.mode !== 'demo') throw forbidden('Доступно только с демо-порталом');
    const row = getVisibleTicketRow(ctx.db, user, params.id);
    if (!canProcess(user, row)) throw forbidden();
    const task = ctx.db.prepare('SELECT task_id FROM b24_tasks WHERE ticket_id = ?').get(row.id);
    if (!task) throw badRequest('Задача в Битрикс24 ещё не создана');
    await external(async () => {
      await b24Call(ctx.integrations.endpoints().b24, 'tasks.task.complete', { taskId: task.task_id });
      await ctx.integrations.checkTasks({ ticketId: row.id });
    });
    return getTicketDetail(ctx.db, user, row.id, ctx.now());
  }, MUTATE);

  admin('POST', '/api/admin/outbox/:id/retry', ({ ctx, params, log }) => {
    if (!retryOutbox(ctx.db, params.id)) throw notFound('Запись не найдена или уже отправляется');
    log('Повторная отправка в Битрикс24', `запись №${params.id}`);
    return { queued: true };
  }, MUTATE);

  add('GET', '/api/counterparties', ({ ctx }) => listCounterparties(ctx.db));

  // Для регламентного задания 1С: Authorization: Bearer <ONEC_EXPORT_TOKEN>, ?since=<ISO> — только изменённые.
  add('GET', '/api/integrations/1c/tickets', ({ ctx, req, query }) => {
    checkExportToken(ctx.integrations.config.exportToken, req.headers.authorization);
    return exportForOnec(ctx.db, query);
  }, { ...PUBLIC, strict: 'onec-export' }); // лимит по адресу — от подбора токена
}
