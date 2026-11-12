// Сборка приложения: HTTP-сервер, API, статика. Без внешних зависимостей.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import { openDatabase } from './db.js';
import { seedIfEmpty } from './seed.js';
import { seedTemplates } from './templates.js';
import { registerRoutes } from './routes.js';
import { userByToken } from './auth.js';
import { LIMITS, SESSION_COOKIE, ESCALATION_INTERVAL_MS } from './config.js';
import { escalateOverdue } from './escalation.js';
import { readIntegrationConfig, resolveEndpoints, DEMO_PORTAL_PREFIX } from './integrations/config.js';
import { createDelivery, markOutboxHistory } from './integrations/delivery.js';
import { createDemoPortal } from './integrations/demo-portal.js';
import { pollTasks } from './integrations/b24-tasks.js';
import {
  HttpError, createRouter, readJson, ok, fail, sendFile, parseCookies,
} from './http.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function createRateLimiter(limitPerMinute) {
  const windows = new Map();
  return (key, nowMs) => {
    // Истёкшие окна удаляются, чтобы счётчик не рос бесконечно при потоке запросов с разных адресов.
    if (windows.size > LIMITS.rateLimiterKeysMax) {
      for (const [k, w] of windows) if (nowMs - w.start > 60_000) windows.delete(k);
    }
    const current = windows.get(key);
    if (!current || nowMs - current.start > 60_000) {
      windows.set(key, { start: nowMs, count: 1 });
      return true;
    }
    windows.set(key, { ...current, count: current.count + 1 });
    return current.count + 1 <= limitPerMinute;
  };
}

async function serveStatic(publicDir, pathname, res) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = normalize(join(publicDir, relative));
  if (!filePath.startsWith(publicDir + sep)) return fail(res, 404, 'Не найдено');
  try {
    const body = await readFile(filePath);
    return sendFile(res, 200, body, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
  } catch {
    return fail(res, 404, 'Не найдено');
  }
}

// Как часто повторять неудавшуюся отправку в Битрикс24.
const DELIVERY_INTERVAL_MS = 15_000;
// Как часто проверять статусы задач в Битрикс24 (облачный портал не может сообщить о них сам).
const TASK_POLL_INTERVAL_MS = 5 * 60_000;

/**
 * @param {{ dbPath: string, uploadsDir: string, publicDir: string, now?: () => string, seed?: boolean, logger?: Console,
 *   escalationIntervalMs?: number, integrations?: object }} options
 * integrations — подключение к Битрикс24 и 1С вместо переменных окружения (тесты).
 */
export function createApp({
  dbPath, uploadsDir, publicDir, now = () => new Date().toISOString(), seed = true, logger = console,
  escalationIntervalMs = ESCALATION_INTERVAL_MS,
  // Демо-режим разрешает сброс данных кнопкой в настройках. Включается только явно (DEMO_MODE=1),
  // чтобы случайный запуск без настройки не открыл стирание данных.
  demoMode = process.env.DEMO_MODE === '1',
  integrations: integrationOverrides = {},
}) {
  const db = openDatabase(dbPath);
  const seeded = seed && seedIfEmpty(db, now(), uploadsDir);
  seedTemplates(db);
  escalateOverdue(db, now());
  if (seeded) markOutboxHistory(db);
  const config = readIntegrationConfig({ demoMode, overrides: integrationOverrides });
  const demoPortal = config.b24.mode === 'demo' || config.onec.mode === 'demo' ? createDemoPortal() : null;
  let server;
  const endpoints = () => resolveEndpoints(config, `http://127.0.0.1:${server.address().port}`);
  const delivery = createDelivery({ db, mode: () => config.b24.mode, endpoints, now, logger });
  const checkTasks = (options) => pollTasks(db, endpoints().b24, now, options);
  const ctx = { db, uploadsDir, now, demoMode, integrations: { config, endpoints, delivery, checkTasks } };
  const router = createRouter();
  registerRoutes(router);
  const allowMutation = createRateLimiter(LIMITS.mutationsPerMinute);
  // Публичная форма без входа ограничена строже и по адресу отправителя.
  const allowPublicPost = createRateLimiter(LIMITS.publicPostsPerMinute);

  async function handleApi(req, res, url) {
    const route = router.match(req.method, url.pathname);
    if (!route) return fail(res, 404, 'Метод API не найден');
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const user = userByToken(db, token, now());
    if (!route.options.public && !user) return fail(res, 401, 'Требуется вход');
    if (route.options.strict && !allowPublicPost(req.socket.remoteAddress, Date.now())) {
      return fail(res, 429, 'Слишком много отправок, повторите через минуту');
    }
    if (route.options.mutate && !allowMutation(user?.id ?? req.socket.remoteAddress, Date.now())) {
      return fail(res, 429, 'Слишком много запросов, повторите через минуту');
    }
    const hasBody = ['POST', 'PATCH', 'PUT'].includes(req.method);
    const body = hasBody ? await readJson(req, route.options.bodyLimit ?? LIMITS.jsonBodyBytes) : {};
    let statusCode = 200;
    let meta;
    let raw = false;
    const data = await route.handler({
      ctx, req, res, user, token, body,
      params: route.params,
      query: Object.fromEntries(url.searchParams),
      status: (code) => { statusCode = code; },
      setMeta: (value) => { meta = value; },
      sendRaw: (buf, headers) => { raw = true; sendFile(res, 200, buf, headers); },
    });
    // Изменения могли добавить вызовы Битрикс24 в журнал — отправка идёт в фоне, ответ её не ждёт.
    if (hasBody) delivery.kick();
    if (!raw) ok(res, data, statusCode, meta);
  }

  async function handleDemoPortal(req, res, url) {
    const params = req.method === 'POST' ? await readJson(req, LIMITS.jsonBodyBytes) : {};
    demoPortal.handle(req, res, url.pathname.slice(DEMO_PORTAL_PREFIX.length), params);
  }

  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (demoPortal && url.pathname.startsWith(`${DEMO_PORTAL_PREFIX}/`)) return await handleDemoPortal(req, res, url);
      if (req.method !== 'GET') return fail(res, 405, 'Метод не поддерживается');
      return await serveStatic(publicDir, decodeURIComponent(url.pathname), res);
    } catch (error) {
      if (error instanceof HttpError) return fail(res, error.status, error.message);
      logger.error(`[${req.method} ${url.pathname}]`, error);
      return fail(res, 500, 'Внутренняя ошибка сервера');
    }
  });

  // Фоновая проверка просрочек; таймер не держит процесс и останавливается вместе с сервером.
  if (escalationIntervalMs > 0) {
    const timer = setInterval(() => {
      try {
        escalateOverdue(db, now());
        delivery.kick();
      } catch (error) {
        logger.error('[escalation]', error);
      }
    }, escalationIntervalMs);
    timer.unref();
    server.on('close', () => clearInterval(timer));
  }
  // Повторы отправки в Битрикс24 и записи, появившиеся до запуска сервера.
  if (config.b24.mode !== 'off') {
    const retry = setInterval(() => delivery.kick(), DELIVERY_INTERVAL_MS);
    retry.unref();
    const taskPoll = setInterval(() => checkTasks().catch((error) => logger.error('[b24 tasks]', error)), TASK_POLL_INTERVAL_MS);
    taskPoll.unref();
    server.on('close', () => { clearInterval(retry); clearInterval(taskPoll); });
    server.on('listening', () => delivery.kick());
  } else {
    delivery.kick();
  }

  return { server, db, delivery, demoPortal };
}
