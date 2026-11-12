// HTTP API. Все ответы — конверт { ok, data, error }.
import {
  TYPES, PRIORITIES, STATUSES, ROLES, LIMITS, TRANSITIONS,
} from './config.js';
import { forbidden, notFound, badRequest, parseCookies, HttpError } from './http.js';
import { canSeeAnalytics, canAdminister } from './access.js';
import { login, logout, sessionCookie, SESSION_MAX_AGE_S } from './auth.js';
import {
  listTickets, getTicketDetail, similarTickets, improvementsBoard,
} from './tickets-query.js';
import {
  createTicket, changeStatus, addComment, reassign, setPriority, supportTicket, markDuplicate, rateTicket, setPublic, editTicket,
} from './tickets-actions.js';
import { exportTicketsCsv } from './export.js';
import { buildAnalytics, buildReport } from './analytics.js';
import { listCategories, listUsers, createCategory, updateCategory, createUser, updateUser } from './admin.js';
import { uploadAttachment, readAttachment } from './attachments.js';
import { listNotifications, markAllRead, listOutbox } from './notifications.js';
import { setWatching, inviteWatcher, createB24Task } from './collab.js';
import { getSlaDays, setSla, listHolidays, setHolidays, listCalendar, replaceCalendarYear, getWorkHours, setWorkHours } from './settings.js';
import { listTargets, setTargets } from './targets.js';
import { listSolutions } from './solutions.js';
import { castVote, voteSummary } from './votes.js';
import { buildDigest, sendDigest } from './digest.js';
import { importUsers } from './user-import.js';
import { resetDemo } from './demo-reset.js';
import { audit, listAudit } from './audit.js';
import { listTemplates, createTemplate, updateTemplate, deleteTemplate } from './templates.js';
import { saveReport, recognition } from './reports.js';
import {
  listSurveys, createSurvey, getSurvey, submitAnswers, setSurveyOpen, surveyResults,
} from './surveys.js';
import { submitClientFeedback, listClientFeedback, markClientFeedback } from './client-feedback.js';
import { buildHome } from './home.js';
import { registerIntegrationRoutes } from './integrations/routes.js';
import { setContacts } from './contacts.js';
import { fetchCalendarYear, validCalendarRequest, CALENDAR_COUNTRIES } from './integrations/calendar.js';

const describeCalendar = (ctx) => {
  const { calendar } = ctx.integrations.config;
  return { mode: calendar.mode, host: new URL(calendar.url).host, country: calendar.country };
};
import { IntegrationError } from './integrations/clients.js';
import {
  stateCookieName, newState, stateCookie, stateMatches, authorizeUrl, b24UserByCode, b24UserByToken,
} from './integrations/b24-sso.js';

const TASK_WAIT_MS = 3000;
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref(); });


const toList = (dict) => Object.entries(dict).map(([key, label]) => ({ key, label }));

// Вход выбором из списка — в демо-режиме (через демо-портал) и пока вход через Битрикс24 не настроен.
// С настоящим порталом список закрыт даже при DEMO_MODE=1: забытая переменная не должна открыть вход без пароля.
const listLoginAllowed = (ctx) => ctx.integrations.config.sso.mode !== 'live';

function requireListLogin(ctx) {
  if (!listLoginAllowed(ctx)) throw forbidden('Вход — через Битрикс24');
}

// Сотрудник портала → сессия в системе. Уволенный на портале не входит сразу, не дожидаясь
// ежедневной проверки оргструктуры; вход открывает только связь по ID Битрикс24.
function portalSession(ctx, portalUser, { embedded = false } = {}) {
  if (!portalUser.active) return { error: 'inactive' };
  const user = ctx.db.prepare('SELECT id FROM users WHERE b24_id = ? AND is_active = 1').get(portalUser.id);
  if (!user) return { error: 'not_linked' };
  const token = login(ctx.db, user.id, ctx.now(), { embedded });
  return { cookie: sessionCookie(token, SESSION_MAX_AGE_S, { secure: ctx.secureCookie, embedded }) };
}

/** Ответ портала или null, если портал недоступен или отказал (подробности — в журнал сервера). */
async function askPortal(ctx, request) {
  try {
    return await request();
  } catch (error) {
    if (!(error instanceof IntegrationError)) throw error;
    ctx.logger.error('[b24 sso]', error.message);
    return null;
  }
}

// Форму с ключом сотрудника присылает страница портала. Без этой проверки чужой сайт мог бы
// отправить свой ключ и незаметно открыть сотруднику систему под чужой учётной записью.
function fromPortal(req, sso) {
  const { origin } = req.headers;
  if (!origin) return false;
  if (sso.origin) return origin === sso.origin;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

// Вкладка в задаче Битрикс24 открывает обращение, из которого задача создана; пункт меню — главную.
function embedTarget(db, body) {
  if (body.PLACEMENT !== 'TASK_VIEW_TAB') return '/#/home';
  let taskId = '';
  try {
    taskId = String(JSON.parse(body.PLACEMENT_OPTIONS || '{}').taskId ?? '');
  } catch {
    return '/#/home';
  }
  const row = taskId ? db.prepare('SELECT ticket_id FROM b24_tasks WHERE task_id = ?').get(taskId) : null;
  return row ? `/#/t/${row.ticket_id}` : '/#/home';
}

function requireRole(check, user) {
  if (!check(user)) throw forbidden();
}

export function registerRoutes(router) {
  const { add } = router;
  const PUBLIC = { public: true };
  const MUTATE = { mutate: true };

  // --- Сессия (демо-вход) ---
  add('GET', '/api/auth/options', ({ ctx }) => ({
    b24: ctx.integrations.config.sso.mode !== 'off',
    list: listLoginAllowed(ctx),
  }), PUBLIC);
  add('GET', '/api/demo-users', ({ ctx }) => {
    requireListLogin(ctx);
    return { users: listUsers(ctx.db), roles: ROLES };
  }, PUBLIC);
  add('POST', '/api/session', ({ ctx, body, res }) => {
    requireListLogin(ctx);
    const token = login(ctx.db, body.userId, ctx.now());
    res.setHeader('Set-Cookie', sessionCookie(token, SESSION_MAX_AGE_S, { secure: ctx.secureCookie }));
    return { loggedIn: true };
  }, { ...PUBLIC, mutate: true });
  add('DELETE', '/api/session', ({ ctx, token, res }) => {
    const embedded = logout(ctx.db, token);
    res.setHeader('Set-Cookie', sessionCookie('', 0, { secure: ctx.secureCookie, embedded }));
    return { loggedIn: false };
  }, MUTATE);

  // --- Вход через Битрикс24 (OAuth) ---
  const ssoConfig = (ctx) => {
    const { sso } = ctx.integrations.config;
    if (sso.mode === 'off') throw notFound('Вход через Битрикс24 не настроен');
    return sso;
  };
  add('GET', '/api/auth/b24/start', ({ ctx, redirect }) => {
    const sso = ssoConfig(ctx);
    const state = newState();
    redirect(authorizeUrl(sso, ctx.integrations.endpoints().sso, state), [stateCookie(state, ctx.secureCookie)]);
  }, { ...PUBLIC, mutate: true });
  add('GET', '/api/auth/b24/callback', async ({ ctx, req, query, redirect }) => {
    const sso = ssoConfig(ctx);
    const back = (error, cookies = []) =>
      redirect(error ? `/?login_error=${error}` : '/', [stateCookie('', ctx.secureCookie), ...cookies]);
    // state защищает от подстановки чужого кода: вход завершает тот браузер, который его начал.
    if (!stateMatches(parseCookies(req.headers.cookie)[stateCookieName(ctx.secureCookie)], query.state)) return back('state');
    if (query.error || !query.code) return back('denied');
    const portalUser = await askPortal(ctx, () => b24UserByCode(sso, ctx.integrations.endpoints().sso, String(query.code)));
    if (!portalUser) return back('failed');
    const session = portalSession(ctx, portalUser);
    return session.error ? back(session.error) : back(null, [session.cookie]);
  }, { ...PUBLIC, mutate: true });

  // Система внутри портала: пункт левого меню и вкладка в задаче. Битрикс24 открывает адрес приложения
  // во фрейме и присылает формой ключ доступа текущего сотрудника (AUTH_ID) — второй раз входить не нужно.
  add('POST', '/api/auth/b24/app', async ({ ctx, req, body, redirect }) => {
    ssoConfig(ctx);
    const endpoints = ctx.integrations.endpoints().sso;
    if (!fromPortal(req, endpoints) || !body.AUTH_ID) return redirect('/?login_error=denied');
    const portalUser = await askPortal(ctx, () => b24UserByToken(endpoints, String(body.AUTH_ID)));
    if (!portalUser) return redirect('/?login_error=failed');
    const session = portalSession(ctx, portalUser, { embedded: true });
    return session.error ? redirect(`/?login_error=${session.error}`) : redirect(embedTarget(ctx.db, body), [session.cookie]);
  }, { ...PUBLIC, mutate: true, form: true });

  // canSwitch — можно ли вернуться к выбору роли (демо); при входе только через Битрикс24 — просто «Выйти».
  add('GET', '/api/me', ({ ctx, user }) => {
    const own = ctx.db.prepare('SELECT email, phone, position, email_notify FROM users WHERE id = ?').get(user.id);
    return {
      ...user, roleLabel: ROLES[user.role], canSwitch: listLoginAllowed(ctx),
      email: own.email, phone: own.phone, position: own.position, emailNotify: Boolean(own.email_notify),
    };
  });
  // Сотрудник сам правит рабочую почту и телефон; должность — только администратор или Битрикс24.
  add('PATCH', '/api/me/contacts', ({ ctx, user, body }) => {
    const changed = setContacts(ctx.db, user.id, { email: body.email ?? '', phone: body.phone ?? '' });
    if (changed.length) audit(ctx.db, user.id, 'Контакты изменены', `${user.name} (сам): ${changed.join(', ')}`, ctx.now());
    const own = ctx.db.prepare('SELECT email, phone FROM users WHERE id = ?').get(user.id);
    return { email: own.email, phone: own.phone };
  }, MUTATE);
  // Сотрудник сам решает, дублировать ли уведомления на почту.
  add('PATCH', '/api/me/notifications', ({ ctx, user, body }) => {
    if (typeof body.email !== 'boolean') throw badRequest('Ожидается email: true или false');
    ctx.db.prepare('UPDATE users SET email_notify = ? WHERE id = ?').run(body.email ? 1 : 0, user.id);
    return { emailNotify: body.email };
  }, MUTATE);

  // --- Справочники ---
  add('GET', '/api/meta', ({ ctx }) => ({
    types: toList(TYPES),
    priorities: toList(PRIORITIES),
    statuses: toList(STATUSES),
    categories: listCategories(ctx.db, { activeOnly: true }).map(({ id, name }) => ({ id, name })),
    departments: ctx.db.prepare('SELECT DISTINCT department FROM tickets WHERE is_anonymous = 0 ORDER BY department').all().map((r) => r.department),
    staff: listUsers(ctx.db).filter((u) => u.role !== 'employee'),
    limits: { attachmentBytes: LIMITS.attachmentBytes, exportMax: LIMITS.exportMax },
    transitions: TRANSITIONS,
    templates: listTemplates(ctx.db),
    sla: getSlaDays(ctx.db),
    demoMode: ctx.demoMode,
    demoData: ctx.demoData,
    b24Mode: ctx.integrations.config.b24.mode,
    hasCounterparties: ctx.db.prepare('SELECT 1 FROM counterparties WHERE is_active = 1 LIMIT 1').get() !== undefined,
  }));
  add('GET', '/api/home', ({ ctx, user }) => buildHome(ctx.db, user, ctx.now()));

  // --- Обращения ---
  add('GET', '/api/tickets', ({ ctx, user, query, setMeta }) => {
    const { items, total, page, limit } = listTickets(ctx.db, user, query, ctx.now());
    setMeta({ total, page, limit });
    return items;
  });
  add('GET', '/api/tickets/export', ({ ctx, user, query, sendRaw }) => {
    sendRaw(Buffer.from(exportTicketsCsv(ctx.db, user, query, ctx.now()), 'utf8'), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="obrashcheniya.csv"',
      'Cache-Control': 'no-store',
    });
  });
  add('GET', '/api/tickets/similar', ({ ctx, user, query }) =>
    similarTickets(ctx.db, user, String(query.text || '').slice(0, 2000)));
  add('POST', '/api/tickets', ({ ctx, user, body, status }) => {
    const id = createTicket(ctx.db, user, body, ctx.now());
    status(201);
    return getTicketDetail(ctx.db, user, id, ctx.now());
  }, MUTATE);
  add('GET', '/api/tickets/:id', ({ ctx, user, params }) => getTicketDetail(ctx.db, user, params.id, ctx.now()));

  const action = (path, fn) =>
    add('POST', `/api/tickets/:id/${path}`, ({ ctx, user, params, body }) => {
      fn(ctx.db, user, params.id, body, ctx.now());
      return getTicketDetail(ctx.db, user, params.id, ctx.now());
    }, MUTATE);
  action('status', changeStatus);
  action('comments', addComment);
  action('assign', reassign);
  action('priority', setPriority);
  action('duplicate', markDuplicate);
  action('feedback', rateTicket);
  add('POST', '/api/tickets/:id/watch', ({ ctx, user, params, body }) => {
    setWatching(ctx.db, user, params.id, body, ctx.now());
    try {
      return getTicketDetail(ctx.db, user, params.id, ctx.now());
    } catch (error) {
      // Приглашённый коллега отписался и больше не видит обращение: действие выполнено, карточки нет.
      if (error.status === 404) return { left: true };
      throw error;
    }
  }, MUTATE);
  action('invite', inviteWatcher);
  add('POST', '/api/tickets/:id/b24-task', async ({ ctx, user, params, body }) => {
    const live = ctx.integrations.config.b24.mode !== 'off';
    createB24Task(ctx.db, user, params.id, body, ctx.now(), { live });
    // Портал обычно отвечает за доли секунды: ждём немного, чтобы карточка сразу показала номер задачи.
    // Если портал медлит, отправка продолжится в фоне, а номер появится в истории позже.
    if (live) await Promise.race([ctx.integrations.delivery.kick(), delay(TASK_WAIT_MS)]);
    return getTicketDetail(ctx.db, user, params.id, ctx.now());
  }, MUTATE);
  action('report', saveReport);
  action('publish', setPublic);
  add('PATCH', '/api/tickets/:id', ({ ctx, user, params, body }) => {
    editTicket(ctx.db, user, params.id, body, ctx.now());
    return getTicketDetail(ctx.db, user, params.id, ctx.now());
  }, MUTATE);
  action('vote', castVote);
  add('GET', '/api/votes', ({ ctx, user }) => voteSummary(ctx.db, user.id));

  add('POST', '/api/tickets/:id/support', ({ ctx, user, params }) =>
    ({ supportsCount: supportTicket(ctx.db, user, params.id, ctx.now()) }), MUTATE);

  add('POST', '/api/tickets/:id/attachments', ({ ctx, user, params, body, status }) => {
    status(201);
    return uploadAttachment(ctx.db, ctx.uploadsDir, user, params.id, body, ctx.now());
  }, { mutate: true, bodyLimit: LIMITS.uploadBodyBytes });
  add('GET', '/api/attachments/:id', ({ ctx, user, params, sendRaw }) => {
    const file = readAttachment(ctx.db, ctx.uploadsDir, user, params.id);
    sendRaw(file.body, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    });
  });

  // --- Прозрачность, аналитика, уведомления ---
  add('GET', '/api/solutions', ({ ctx, user, query }) => listSolutions(ctx.db, user, query));
  add('GET', '/api/board', ({ ctx }) => ({ ...improvementsBoard(ctx.db), ...recognition(ctx.db, ctx.now()) }));
  add('GET', '/api/digest', ({ ctx, user }) => {
    requireRole(canSeeAnalytics, user);
    return buildDigest(ctx.db, ctx.now());
  });
  add('POST', '/api/digest/send', ({ ctx, user }) => {
    requireRole(canSeeAnalytics, user);
    return { recipients: sendDigest(ctx.db, ctx.now()) };
  }, MUTATE);
  add('GET', '/api/report', ({ ctx, user, query }) => {
    requireRole(canSeeAnalytics, user);
    return buildReport(ctx.db, query, ctx.now());
  });

  // --- Опросы сотрудников ---
  add('GET', '/api/surveys', ({ ctx, user }) => listSurveys(ctx.db, user));
  add('POST', '/api/surveys', ({ ctx, user, body, status }) => {
    status(201);
    return { id: createSurvey(ctx.db, user, body, ctx.now()) };
  }, MUTATE);
  add('GET', '/api/surveys/:id', ({ ctx, user, params }) => getSurvey(ctx.db, user, params.id));
  add('GET', '/api/surveys/:id/results', ({ ctx, user, params }) => surveyResults(ctx.db, user, params.id));
  add('POST', '/api/surveys/:id/answers', ({ ctx, user, params, body }) => {
    submitAnswers(ctx.db, user, params.id, body, ctx.now());
    return { done: true };
  }, MUTATE);
  add('PATCH', '/api/surveys/:id', ({ ctx, user, params, body }) => {
    setSurveyOpen(ctx.db, user, params.id, body);
    return listSurveys(ctx.db, user);
  }, MUTATE);

  // --- Обратная связь от клиентов: отправка без входа, просмотр — руководителю ---
  add('POST', '/api/public/feedback', ({ ctx, body, status }) => {
    submitClientFeedback(ctx.db, body, ctx.now());
    status(201);
    return { accepted: true };
  }, { public: true, mutate: true, strict: true });
  add('GET', '/api/client-feedback', ({ ctx, user }) => listClientFeedback(ctx.db, user));
  add('PATCH', '/api/client-feedback/:id', ({ ctx, user, params, body }) => {
    markClientFeedback(ctx.db, user, params.id, body);
    return listClientFeedback(ctx.db, user);
  }, MUTATE);
  add('GET', '/api/analytics', ({ ctx, user }) => {
    requireRole(canSeeAnalytics, user);
    return buildAnalytics(ctx.db, ctx.now());
  });
  add('GET', '/api/notifications', ({ ctx, user }) => listNotifications(ctx.db, user.id));
  add('POST', '/api/notifications/read', ({ ctx, user }) => {
    markAllRead(ctx.db, user.id);
    return { done: true };
  }, MUTATE);

  // --- Администрирование (каждое изменение попадает в журнал действий) ---
  const admin = (method, path, handler, options) => add(method, path, (args) => {
    requireRole(canAdminister, args.user);
    return handler({ ...args, log: (action, details) => audit(args.ctx.db, args.user.id, action, details, args.ctx.now()) });
  }, options);

  admin('GET', '/api/admin/categories', ({ ctx }) => listCategories(ctx.db));
  admin('POST', '/api/admin/categories', ({ ctx, body, status, log }) => {
    const id = createCategory(ctx.db, body);
    log('Категория создана', String(body.name).trim());
    status(201);
    return { id };
  }, MUTATE);
  admin('PATCH', '/api/admin/categories/:id', ({ ctx, params, body, log }) => {
    updateCategory(ctx.db, params.id, body);
    const name = ctx.db.prepare('SELECT name FROM categories WHERE id = ?').get(Number(params.id))?.name;
    log('Категория изменена', `${name}: ${Object.keys(body).join(', ')}`);
    return listCategories(ctx.db);
  }, MUTATE);

  admin('GET', '/api/admin/sla', ({ ctx }) => getSlaDays(ctx.db));
  admin('PATCH', '/api/admin/sla', ({ ctx, body, log }) => {
    setSla(ctx.db, body);
    log('Сроки SLA изменены', getSlaDays(ctx.db).map((s) => `${s.label}: ${s.firstResponseDays}/${s.resolveDays}`).join('; '));
    return getSlaDays(ctx.db);
  }, MUTATE);
  admin('GET', '/api/admin/targets', ({ ctx }) => listTargets(ctx.db));
  admin('PATCH', '/api/admin/targets', ({ ctx, body, log }) => {
    setTargets(ctx.db, body);
    const targets = listTargets(ctx.db);
    log('Цели показателей изменены', targets.map((t) => `${t.label}: ${t.dir === 'min' ? '≥' : '≤'} ${t.value} ${t.unit}`).join('; '));
    return targets;
  }, MUTATE);
  admin('GET', '/api/admin/holidays', ({ ctx }) => listHolidays(ctx.db));
  admin('PATCH', '/api/admin/holidays', ({ ctx, body, log }) => {
    log('Список праздников изменён', `дат: ${setHolidays(ctx.db, body)}`);
    return listHolidays(ctx.db);
  }, MUTATE);

  admin('GET', '/api/admin/work-hours', ({ ctx }) => getWorkHours(ctx.db));
  admin('PATCH', '/api/admin/work-hours', ({ ctx, body, log }) => {
    const hours = setWorkHours(ctx.db, body);
    log('Рабочие часы изменены', hours ? `с ${hours.start}:00 до ${hours.end}:00` : 'сутки целиком');
    return hours;
  }, MUTATE);
  admin('GET', '/api/admin/calendar', ({ ctx }) => ({ ...listCalendar(ctx.db), source: describeCalendar(ctx) }));
  // Загрузка производственного календаря на год: праздники и рабочие выходные заменяют записи этого года.
  admin('POST', '/api/admin/calendar/import', async ({ ctx, body, log }) => {
    const { year, country } = validCalendarRequest(body, ctx.now());
    let loaded;
    try {
      loaded = await fetchCalendarYear(ctx.integrations.endpoints().calendar, year, country);
    } catch (error) {
      if (error instanceof IntegrationError) throw new HttpError(502, error.message);
      throw error;
    }
    replaceCalendarYear(ctx.db, year, loaded);
    log('Производственный календарь загружен', `${year}, ${CALENDAR_COUNTRIES[country]}: праздников ${loaded.holidays.length}, рабочих выходных ${loaded.workdays.length}`);
    return { ...listCalendar(ctx.db), loaded: { year, holidays: loaded.holidays.length, workdays: loaded.workdays.length } };
  }, MUTATE);

  admin('GET', '/api/admin/templates', ({ ctx }) => listTemplates(ctx.db));
  admin('POST', '/api/admin/templates', ({ ctx, body, status, log }) => {
    const created = createTemplate(ctx.db, body);
    log('Шаблон ответа создан', created.title);
    status(201);
    return listTemplates(ctx.db);
  }, MUTATE);
  admin('PATCH', '/api/admin/templates/:id', ({ ctx, params, body, log }) => {
    log('Шаблон ответа изменён', updateTemplate(ctx.db, params.id, body).title);
    return listTemplates(ctx.db);
  }, MUTATE);
  admin('DELETE', '/api/admin/templates/:id', ({ ctx, params, log }) => {
    log('Шаблон ответа удалён', deleteTemplate(ctx.db, params.id));
    return listTemplates(ctx.db);
  }, MUTATE);

  admin('GET', '/api/admin/users', ({ ctx }) => listUsers(ctx.db, { includeInactive: true, withB24: true }));
  admin('POST', '/api/admin/users', ({ ctx, body, status, log }) => {
    const created = createUser(ctx.db, body);
    log('Пользователь создан', `${created.name} (${body.role})`);
    status(201);
    return listUsers(ctx.db, { includeInactive: true, withB24: true });
  }, MUTATE);
  admin('PATCH', '/api/admin/users/:id/contacts', ({ ctx, params, body, log }) => {
    const changed = setContacts(ctx.db, params.id, body);
    if (!changed) throw notFound('Пользователь не найден');
    const { name } = ctx.db.prepare('SELECT name FROM users WHERE id = ?').get(Number(params.id));
    if (changed.length) log('Контакты изменены', `${name}: ${changed.join(', ')}`);
    return listUsers(ctx.db, { includeInactive: true, withB24: true });
  }, MUTATE);
  admin('PATCH', '/api/admin/users/:id', ({ ctx, user, params, body, log }) => {
    log('Пользователь изменён', updateUser(ctx.db, user, params.id, body, ctx.now()));
    return listUsers(ctx.db, { includeInactive: true, withB24: true });
  }, MUTATE);

  admin('POST', '/api/admin/users/import', ({ ctx, body, log }) => {
    const result = importUsers(ctx.db, body);
    log('Импорт пользователей', `добавлено: ${result.created.length}, пропущено: ${result.skipped.length}`);
    return { ...result, users: listUsers(ctx.db, { includeInactive: true, withB24: true }) };
  }, { mutate: true, bodyLimit: 128 * 1024 });
  // Сброс удаляет все сессии, поэтому администратор после него попадает на экран входа.
  admin('POST', '/api/admin/demo-reset', ({ ctx, user, res }) => {
    if (!ctx.demoMode) throw forbidden('Сброс данных доступен только в демо-режиме');
    ctx.integrations.delivery.invalidate();
    resetDemo(ctx.db, ctx.uploadsDir, user.name, ctx.now());
    res.setHeader('Set-Cookie', sessionCookie('', 0, { secure: ctx.secureCookie }));
    return { reset: true };
  }, MUTATE);
  admin('GET', '/api/admin/outbox', ({ ctx }) => listOutbox(ctx.db));
  admin('GET', '/api/admin/audit', ({ ctx }) => listAudit(ctx.db));
  registerIntegrationRoutes({ add, admin, PUBLIC, MUTATE });
}
