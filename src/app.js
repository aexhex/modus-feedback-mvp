// Сборка приложения: HTTP-сервер, API, статика. Без внешних зависимостей.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import { openDatabase } from './db.js';
import { seedIfEmpty, bootstrapAdmin } from './seed.js';
import { seedTemplates } from './templates.js';
import { registerRoutes } from './routes.js';
import { userByToken, renewSession, sessionCookie, SESSION_MAX_AGE_S } from './auth.js';
import { LIMITS, SESSION_COOKIE, ESCALATION_INTERVAL_MS } from './config.js';
import { escalateOverdue } from './escalation.js';
import { readIntegrationConfig, resolveEndpoints, DEMO_PORTAL_PREFIX } from './integrations/config.js';
import { createDelivery, markOutboxHistory } from './integrations/delivery.js';
import { createDemoPortal } from './integrations/demo-portal.js';
import { createDemoSmtp } from './integrations/demo-smtp.js';
import { pollTasks } from './integrations/b24-tasks.js';
import { runDailySync } from './integrations/daily.js';
import { backup, backupKeep } from './backup.js';
import { runRetention } from './retention.js';
import { audit } from './audit.js';
import { vapidKeys } from './integrations/webpush.js';
import {
  HttpError, createRouter, readJson, readForm, ok, fail, sendFile, parseCookies, clientIp, pageHeaders,
  decodeComponent,
} from './http.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function createRateLimiter(limitPerMinute) {
  const windows = new Map();
  let sweptAt = 0;
  return (key, nowMs) => {
    // Истёкшие окна удаляются, чтобы счётчик не рос бесконечно при потоке запросов с разных адресов.
    // Обход — не чаще раза в секунду; если и после него ключей слишком много, забываются самые старые.
    if (windows.size > LIMITS.rateLimiterKeysMax && nowMs - sweptAt > 1000) {
      sweptAt = nowMs;
      for (const [k, w] of windows) if (nowMs - w.start > 60_000) windows.delete(k);
      for (const k of windows.keys()) {
        if (windows.size <= LIMITS.rateLimiterKeysMax) break;
        windows.delete(k);
      }
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

async function serveStatic(publicDir, pathname, res, frameAncestors) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = normalize(join(publicDir, relative));
  if (!filePath.startsWith(publicDir + sep)) return fail(res, 404, 'Не найдено');
  try {
    const body = await readFile(filePath);
    return sendFile(res, 200, body, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    }, pageHeaders(frameAncestors));
  } catch {
    return fail(res, 404, 'Не найдено');
  }
}

// Как часто повторять неудавшуюся отправку в Битрикс24.
const DELIVERY_INTERVAL_MS = 15_000;
// Как часто проверять статусы задач в Битрикс24 (облачный портал не может сообщить о них сам).
const TASK_POLL_INTERVAL_MS = 5 * 60_000;
// Справочники компании: контрагенты 1С и проверка оргструктуры Битрикс24 — раз в сутки и через минуту после запуска.
const DAILY_SYNC_MS = 24 * 3600_000;
const DAILY_SYNC_FIRST_MS = 60_000;

/**
 * @param {{ dbPath: string, uploadsDir: string, publicDir: string, now?: () => string, seed?: boolean, logger?: Console,
 *   escalationIntervalMs?: number, integrations?: object }} options
 * integrations — подключение к Битрикс24 и 1С вместо переменных окружения (тесты).
 */
export function createApp({
  // DEMO_DATA=0 — рабочий запуск: вместо демо-датасета в пустой базе только администратор.
  dbPath, uploadsDir, publicDir, now = () => new Date().toISOString(), seed = process.env.DEMO_DATA !== '0', logger = console,
  escalationIntervalMs = ESCALATION_INTERVAL_MS,
  // Демо-режим разрешает сброс данных кнопкой в настройках. Включается только явно (DEMO_MODE=1),
  // чтобы случайный запуск без настройки не открыл стирание данных.
  demoMode = process.env.DEMO_MODE === '1',
  // Вход выбором из списка без пароля вне демо — только явно (ALLOW_LIST_LOGIN=1) и только во внутренней сети.
  allowListLogin = process.env.ALLOW_LIST_LOGIN === '1',
  integrations: integrationOverrides = {},
  // false — только для тестов: push уходит на локальную «службу push» вместо настоящих.
  pushCheckHost = true,
  // За HTTPS-прокси: адрес клиента из X-Forwarded-For и cookie сессии только по HTTPS.
  trustProxy = process.env.TRUST_PROXY === '1',
  secureCookie = process.env.COOKIE_SECURE === '1' || /^https:/i.test(process.env.PUBLIC_URL ?? ''),
  // Каталог резервных копий: если задан, база и вложения копируются раз в сутки.
  backupDir = process.env.BACKUP_DIR || null,
}) {
  const db = openDatabase(dbPath);
  const seeded = seed && seedIfEmpty(db, now(), uploadsDir);
  if (!seed) bootstrapAdmin(db, process.env.ADMIN_NAME, process.env.ADMIN_B24_ID);
  seedTemplates(db);
  escalateOverdue(db, now());
  if (seeded) markOutboxHistory(db);
  const config = readIntegrationConfig({ demoMode, overrides: integrationOverrides });
  // Учебный почтовый сервер слушает только 127.0.0.1; письма видны на /demo-portal/mail/.
  const demoSmtp = config.mail.mode === 'demo' ? createDemoSmtp() : null;
  demoSmtp?.listen().catch((error) => logger.error('[demo smtp]', error));
  const demoPortal = config.b24.mode === 'demo' || config.onec.mode === 'demo' || config.calendar.mode === 'demo' || demoSmtp
    ? createDemoPortal({ mailbox: demoSmtp?.messages ?? [] }) : null;
  const mailServer = () => (config.mail.mode === 'demo'
    ? { host: '127.0.0.1', port: demoSmtp.port(), secure: false, from: config.mail.from }
    : config.mail);
  let server;
  const endpoints = () => resolveEndpoints(config, `http://127.0.0.1:${server.address().port}`);
  // Push: ключи сервера (VAPID) и контакт для служб push — адрес отправителя писем или VAPID_SUBJECT.
  const push = {
    keys: vapidKeys(db),
    subject: process.env.VAPID_SUBJECT || `mailto:${config.mail.from}`,
    checkHost: pushCheckHost,
  };
  const delivery = createDelivery({
    db, mode: () => config.b24.mode, endpoints, now, logger, mailMode: () => config.mail.mode, mailServer, pushContext: () => push,
  });
  const checkTasks = (options) => pollTasks(db, endpoints().b24, now, options);
  const ctx = { db, uploadsDir, now, demoMode, allowListLogin, demoData: seed, secureCookie, logger, push, integrations: { config, endpoints, delivery, checkTasks } };
  // Показ во фрейме: системе внутри портала Битрикс24 — только порталу компании; в демо — своей странице демо-портала.
  const frameAncestors = { live: config.sso.portal, demo: "'self'" }[config.sso.mode] ?? null;
  const router = createRouter();
  registerRoutes(router);
  const allowMutation = createRateLimiter(LIMITS.mutationsPerMinute);
  // Публичная форма без входа и выгрузка для 1С ограничены строже и по адресу отправителя — у каждой свой
  // счётчик, чтобы подбор токена выгрузки не блокировал отзывы клиентов и наоборот.
  const strictLimiters = new Map();
  const allowStrict = (bucket, key, nowMs) => {
    if (!strictLimiters.has(bucket)) strictLimiters.set(bucket, createRateLimiter(LIMITS.publicPostsPerMinute));
    return strictLimiters.get(bucket)(key, nowMs);
  };

  async function handleApi(req, res, url) {
    const route = router.match(req.method, url.pathname);
    if (!route) return fail(res, 404, 'Метод API не найден');
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const user = userByToken(db, token, now());
    if (!route.options.public && !user) return fail(res, 401, 'Требуется вход');
    const ip = clientIp(req, trustProxy);
    if (route.options.strict && !allowStrict(route.options.strict, ip, Date.now())) {
      return fail(res, 429, 'Слишком много отправок, повторите через минуту');
    }
    if (route.options.mutate && !allowMutation(user?.id ?? ip, Date.now())) {
      return fail(res, 429, 'Слишком много запросов, повторите через минуту');
    }
    // Продлевает сессию только работа человека; фоновый опрос уведомлений (x-background) — нет,
    // иначе открытая и забытая вкладка держала бы сессию бесконечно.
    if (user && req.headers['x-background'] !== '1') {
      const renewed = renewSession(db, token, now());
      if (renewed) res.setHeader('Set-Cookie', sessionCookie(token, SESSION_MAX_AGE_S, { secure: secureCookie, embedded: renewed.embedded }));
    }
    const hasBody = ['POST', 'PATCH', 'PUT'].includes(req.method);
    const readBody = route.options.form ? readForm : readJson;
    const body = hasBody ? await readBody(req, route.options.bodyLimit ?? LIMITS.jsonBodyBytes) : {};
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
      redirect: (location, cookies = []) => {
        raw = true;
        sendFile(res, 302, '', { Location: location, 'Set-Cookie': cookies, 'Cache-Control': 'no-store' });
      },
    });
    // Изменения могли добавить вызовы Битрикс24 в журнал — отправка идёт в фоне, ответ её не ждёт.
    if (hasBody) delivery.kick();
    if (!raw) ok(res, data, statusCode, meta);
  }

  async function handleDemoPortal(req, res, url) {
    const body = req.method === 'POST' ? await readJson(req, LIMITS.jsonBodyBytes) : {};
    const params = { ...Object.fromEntries(url.searchParams), ...body };
    demoPortal.handle(req, res, url.pathname.slice(DEMO_PORTAL_PREFIX.length), params);
  }

  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (demoPortal && url.pathname.startsWith(`${DEMO_PORTAL_PREFIX}/`)) return await handleDemoPortal(req, res, url);
      if (req.method !== 'GET') return fail(res, 405, 'Метод не поддерживается');
      return await serveStatic(publicDir, decodeComponent(url.pathname), res, frameAncestors);
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
  if (config.b24.mode !== 'off' || config.onec.mode !== 'off') {
    const daily = () => runDailySync({ db, config, endpoints, now, logger });
    const first = setTimeout(daily, DAILY_SYNC_FIRST_MS);
    const every = setInterval(daily, DAILY_SYNC_MS);
    first.unref();
    every.unref();
    server.on('close', () => { clearTimeout(first); clearInterval(every); });
  }

  // Раз в сутки: обезличивание уволенных, у которых истёк срок хранения (если срок задан).
  const retention = () => {
    try {
      const count = runRetention(db, now());
      if (count) audit(db, null, 'Персональные данные обезличены', `по сроку хранения: ${count}`, now());
    } catch (error) {
      logger.error('[retention]', error);
    }
  };
  const retentionFirst = setTimeout(retention, DAILY_SYNC_FIRST_MS);
  const retentionEvery = setInterval(retention, DAILY_SYNC_MS);
  retentionFirst.unref();
  retentionEvery.unref();
  server.on('close', () => { clearTimeout(retentionFirst); clearInterval(retentionEvery); });

  if (backupDir) {
    const daily = () => {
      try {
        backup(db, { uploadsDir, backupDir, keep: backupKeep(process.env.BACKUP_KEEP), nowIso: now() });
      } catch (error) {
        logger.error('[backup]', error);
      }
    };
    const first = setTimeout(daily, DAILY_SYNC_FIRST_MS);
    const every = setInterval(daily, DAILY_SYNC_MS);
    first.unref();
    every.unref();
    server.on('close', () => { clearTimeout(first); clearInterval(every); });
  }

  if (demoSmtp) server.on('close', () => { demoSmtp.close(); });

  return { server, db, delivery, demoPortal, demoSmtp };
}
