// Вход через Битрикс24: OAuth 2.0 локального приложения облачного портала.
// 1) /api/auth/b24/start — случайный state в cookie и переход на страницу входа портала;
// 2) портал возвращает сотрудника на /api/auth/b24/callback с одноразовым кодом;
// 3) сервер меняет код на токен, проверяет, что токен выдан нашим порталом, и спрашивает user.current;
// 4) сотрудник находится по ID Битрикс24 — связь появляется при загрузке оргструктуры.
// Пароль Битрикс24 система не видит, токен портала не хранит: после входа — обычная сессия.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fetchJson, IntegrationError } from './clients.js';

// По HTTPS — префикс __Host-: такую cookie нельзя подложить с соседнего поддомена (браузер требует
// Secure и Path=/), поэтому чужой state не подменит вход. По HTTP (демо, локальная сеть) — обычная.
export const stateCookieName = (secure) => (secure ? '__Host-b24_state' : 'b24_state');
const STATE_TTL_S = 600;

export const newState = () => randomBytes(24).toString('hex');

// SameSite=Lax: портал возвращает сотрудника обычным переходом с другого сайта, Strict-cookie он бы не принёс.
export const stateCookie = (value, secure) =>
  `${stateCookieName(secure)}=${value}; Path=${secure ? '/' : '/api/auth/b24/'}; HttpOnly; SameSite=Lax; Max-Age=${value ? STATE_TTL_S : 0}${secure ? '; Secure' : ''}`;

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
  return b24UserByToken(endpoints, body.access_token);
}

/**
 * Ключ, присланный порталом в окно приложения (AUTH_ID) → { id, active }. Сначала app.info: ключ должен быть
 * выдан именно нашему приложению. Иначе стороннее приложение портала, получившее ключ сотрудника, вошло бы
 * от его имени, подставив заголовок Origin (его проверяют только браузеры).
 */
export async function b24UserByAppToken(sso, endpoints, accessToken) {
  const app = await fetchJson(`${endpoints.rest}app.info.json?auth=${encodeURIComponent(accessToken)}`, {
    headers: { accept: 'application/json' },
  });
  const result = app.body?.result ?? {};
  // У локального приложения код приложения совпадает с client_id.
  if (![result.CLIENT_ID, result.CODE].includes(sso.clientId)) {
    throw new IntegrationError(`Битрикс24 app.info: ключ выдан другому приложению${app.body?.error ? ` (${app.body.error})` : ''}`);
  }
  return b24UserByToken(endpoints, accessToken);
}

/**
 * Ключ доступа сотрудника → { id, active }. Ключ проверяет сам портал компании (адрес из настроек,
 * а не из запроса): ключ другого портала здесь недействителен.
 */
async function b24UserByToken(endpoints, accessToken) {
  const me = await fetchJson(`${endpoints.rest}user.current.json?auth=${encodeURIComponent(accessToken)}`, {
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
