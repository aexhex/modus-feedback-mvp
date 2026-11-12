// Вход через Битрикс24: OAuth 2.0 локального приложения облачного портала.
// 1) /api/auth/b24/start — случайный state в cookie и переход на страницу входа портала;
// 2) портал возвращает сотрудника на /api/auth/b24/callback с одноразовым кодом;
// 3) сервер меняет код на токен, проверяет, что токен выдан нашим порталом, и спрашивает user.current;
// 4) сотрудник находится по ID Битрикс24 — связь появляется при загрузке оргструктуры.
// Пароль Битрикс24 система не видит, токен портала не хранит: после входа — обычная сессия.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fetchJson, IntegrationError } from './clients.js';

export const STATE_COOKIE = 'b24_state';
const STATE_TTL_S = 600;

export const newState = () => randomBytes(24).toString('hex');

// SameSite=Lax: портал возвращает сотрудника обычным переходом с другого сайта, Strict-cookie он бы не принёс.
export const stateCookie = (value, secure) =>
  `${STATE_COOKIE}=${value}; Path=/api/auth/b24/; HttpOnly; SameSite=Lax; Max-Age=${value ? STATE_TTL_S : 0}${secure ? '; Secure' : ''}`;

export function stateMatches(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string' || !expected || expected.length !== received.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

export const authorizeUrl = (sso, endpoints, state) =>
  `${endpoints.authorize}?${new URLSearchParams({ client_id: sso.clientId, state })}`;

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

/** Одноразовый код с адреса возврата → { id, active } пользователя Битрикс24. */
export async function b24UserByCode(sso, endpoints, code) {
  const query = new URLSearchParams({
    grant_type: 'authorization_code', client_id: sso.clientId, client_secret: sso.clientSecret, code,
  });
  const { body } = await fetchJson(`${endpoints.token}?${query}`, { headers: { accept: 'application/json' } });
  if (!body?.access_token) throw new IntegrationError(`Битрикс24 OAuth: ${body?.error_description || body?.error || 'нет токена'}`);
  // Токен другого портала сюда не пускаем: client_endpoint — адрес REST портала, выдавшего токен.
  if (hostOf(body.client_endpoint) !== endpoints.domain) {
    throw new IntegrationError(`Битрикс24 OAuth: токен выдан другим порталом (${hostOf(body.client_endpoint)})`);
  }
  const me = await fetchJson(`${endpoints.rest}user.current.json?auth=${encodeURIComponent(body.access_token)}`, {
    headers: { accept: 'application/json' },
  });
  const id = Number(me.body?.result?.ID);
  if (!Number.isInteger(id) || id <= 0) {
    throw new IntegrationError(`Битрикс24 user.current: ${me.body?.error_description || me.body?.error || 'нет ID пользователя'}`);
  }
  // ACTIVE в REST Битрикс24 — true/false или 'Y'/'N' в зависимости от метода и версии.
  const flag = me.body.result.ACTIVE;
  return { id, active: flag !== false && flag !== 'N' };
}
