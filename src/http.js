export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Адрес клиента для ограничения частоты запросов. За обратным прокси (HTTPS-терминатор) все запросы
 * приходят с адреса прокси, поэтому при TRUST_PROXY=1 берётся последний адрес из X-Forwarded-For — его
 * дописал наш прокси. Левые адреса клиент может подставить сам. Включать только за своим прокси.
 */
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').at(-1).trim();
    if (forwarded) return forwarded.slice(0, 64);
  }
  return req.socket.remoteAddress;
}

export const badRequest = (msg) => new HttpError(400, msg);
export const forbidden = (msg = 'Недостаточно прав') => new HttpError(403, msg);
export const notFound = (msg = 'Не найдено') => new HttpError(404, msg);

/** decodeURIComponent без 500 на битой кодировке («%», «%zz»): это ошибка запроса, а не сервера. */
export function decodeComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw badRequest('Неверная кодировка адреса');
  }
}

const csp = (frameAncestors) =>
  `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors ${frameAncestors}`;
const BASE_HEADERS = Object.freeze({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
const SECURITY_HEADERS = Object.freeze({ ...BASE_HEADERS, 'X-Frame-Options': 'DENY', 'Content-Security-Policy': csp("'none'") });

/**
 * Заголовки страниц интерфейса. По умолчанию показ во фрейме запрещён; frameAncestors — кому разрешён
 * (портал Битрикс24 компании или сам сервер для демо-портала), когда система открывается внутри портала.
 */
export const pageHeaders = (frameAncestors) =>
  (frameAncestors ? { ...BASE_HEADERS, 'Content-Security-Policy': csp(frameAncestors) } : SECURITY_HEADERS);

export function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

export const ok = (res, data, status = 200, meta) =>
  sendJson(res, status, { ok: true, data, error: null, ...(meta ? { meta } : {}) });

export const fail = (res, status, message) =>
  sendJson(res, status, { ok: false, data: null, error: message });

export function sendFile(res, status, body, headers, base = SECURITY_HEADERS) {
  res.writeHead(status, { ...base, ...headers });
  res.end(body);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, 'Слишком большой запрос'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function readJson(req, maxBytes) {
  const type = req.headers['content-type'] || '';
  if (!type.startsWith('application/json')) throw new HttpError(415, 'Ожидается Content-Type: application/json');
  const text = await readBody(req, maxBytes);
  if (!text) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest('Некорректный JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw badRequest('Тело запроса должно быть JSON-объектом');
  return parsed;
}

// Форма — только для открытия системы внутри портала: Битрикс24 присылает данные приложения обычной формой.
export async function readForm(req, maxBytes) {
  const type = req.headers['content-type'] || '';
  if (!type.startsWith('application/x-www-form-urlencoded')) throw new HttpError(415, 'Ожидается форма');
  return Object.fromEntries(new URLSearchParams(await readBody(req, maxBytes)));
}

export function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const idx = part.indexOf('=');
        if (idx < 0) return [part, ''];
        const raw = part.slice(idx + 1);
        // Чужая cookie с битой кодировкой не должна ломать запрос: оставляем её как есть.
        try {
          return [part.slice(0, idx), decodeURIComponent(raw)];
        } catch {
          return [part.slice(0, idx), raw];
        }
      }),
  );
}

// Минимальный роутер: шаблоны вида /api/tickets/:id
export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler, options = {}) => {
    const keys = [];
    const regex = new RegExp(
      '^' + pattern.replace(/:(\w+)/g, (_, key) => (keys.push(key), '([^/]+)')) + '$',
    );
    routes.push({ method, regex, keys, handler, options });
  };
  const match = (method, path) => {
    for (const route of routes) {
      if (route.method !== method) continue;
      const m = route.regex.exec(path);
      if (!m) continue;
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeComponent(m[i + 1])]));
      return { ...route, params };
    }
    return null;
  };
  return { add, match };
}
