// HTTP API. Все ответы — конверт { ok, data, error }.
import { TYPES, PRIORITIES, STATUSES, ROLES, LIMITS, SESSION_COOKIE } from './config.js';
import { forbidden, badRequest } from './http.js';
import { canSeeAnalytics, canAdminister } from './access.js';
import { login, logout } from './auth.js';
import {
  listTickets, getTicketDetail, similarTickets, improvementsBoard,
} from './tickets-query.js';
import {
  createTicket, changeStatus, addComment, reassign, setPriority, supportTicket, markDuplicate,
} from './tickets-actions.js';
import { buildAnalytics } from './analytics.js';
import { listCategories, listUsers, createCategory, updateCategory, setAvailability } from './admin.js';
import { uploadAttachment, readAttachment } from './attachments.js';
import { listNotifications, markAllRead } from './notifications.js';

const cookie = (token, maxAge) =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;

const toList = (dict) => Object.entries(dict).map(([key, label]) => ({ key, label }));

function requireRole(check, user) {
  if (!check(user)) throw forbidden();
}

export function registerRoutes(router) {
  const { add } = router;
  const PUBLIC = { public: true };
  const MUTATE = { mutate: true };

  // --- Сессия (демо-вход) ---
  add('GET', '/api/demo-users', ({ ctx }) => ({ users: listUsers(ctx.db), roles: ROLES }), PUBLIC);
  add('POST', '/api/session', ({ ctx, body, res }) => {
    const token = login(ctx.db, body.userId, ctx.now());
    res.setHeader('Set-Cookie', cookie(token, 60 * 60 * 12));
    return { loggedIn: true };
  }, { ...PUBLIC, mutate: true });
  add('DELETE', '/api/session', ({ ctx, token, res }) => {
    logout(ctx.db, token);
    res.setHeader('Set-Cookie', cookie('', 0));
    return { loggedIn: false };
  }, MUTATE);
  add('GET', '/api/me', ({ user }) => ({ ...user, roleLabel: ROLES[user.role] }));

  // --- Справочники ---
  add('GET', '/api/meta', ({ ctx }) => ({
    types: toList(TYPES),
    priorities: toList(PRIORITIES),
    statuses: toList(STATUSES),
    categories: listCategories(ctx.db, { activeOnly: true }).map(({ id, name }) => ({ id, name })),
    departments: ctx.db.prepare('SELECT DISTINCT department FROM tickets ORDER BY department').all().map((r) => r.department),
    staff: listUsers(ctx.db).filter((u) => u.role !== 'employee'),
    limits: { attachmentBytes: LIMITS.attachmentBytes },
  }));

  // --- Обращения ---
  add('GET', '/api/tickets', ({ ctx, user, query }) => listTickets(ctx.db, user, query, ctx.now()));
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
  add('GET', '/api/board', ({ ctx }) => improvementsBoard(ctx.db));
  add('GET', '/api/analytics', ({ ctx, user }) => {
    requireRole(canSeeAnalytics, user);
    return buildAnalytics(ctx.db, ctx.now());
  });
  add('GET', '/api/notifications', ({ ctx, user }) => listNotifications(ctx.db, user.id));
  add('POST', '/api/notifications/read', ({ ctx, user }) => {
    markAllRead(ctx.db, user.id);
    return { done: true };
  }, MUTATE);

  // --- Администрирование ---
  add('GET', '/api/admin/categories', ({ ctx, user }) => {
    requireRole(canAdminister, user);
    return listCategories(ctx.db);
  });
  add('POST', '/api/admin/categories', ({ ctx, user, body, status }) => {
    requireRole(canAdminister, user);
    status(201);
    return { id: createCategory(ctx.db, body) };
  }, MUTATE);
  add('PATCH', '/api/admin/categories/:id', ({ ctx, user, params, body }) => {
    requireRole(canAdminister, user);
    updateCategory(ctx.db, params.id, body);
    return listCategories(ctx.db);
  }, MUTATE);
  add('GET', '/api/admin/users', ({ ctx, user }) => {
    requireRole(canAdminister, user);
    return listUsers(ctx.db);
  });
  add('PATCH', '/api/admin/users/:id', ({ ctx, user, params, body }) => {
    requireRole(canAdminister, user);
    if (Number(params.id) === user.id && body.isAvailable === false) {
      throw badRequest('Нельзя отключить самого себя');
    }
    setAvailability(ctx.db, params.id, body);
    return listUsers(ctx.db);
  }, MUTATE);
}
