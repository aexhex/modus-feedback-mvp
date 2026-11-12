export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Адрес клиента для ограничения частоты запросов. За обратным прокси (HTTPS-терминатор) все запросы
 * приходят с адреса прокси, поэтому при TRUST_PROXY=1 берётся первый адрес из X-Forwarded-For.
 * Включать только за своим прокси: иначе клиент может подставить заголовок сам.
 */
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (forwarded) return forwarded.slice(0, 64);
  }
  return req.socket.remoteAddress;
}

export const badRequest = (msg) => new HttpError(400, msg);
export const forbidden = (msg = 'Недостаточно прав') => new HttpError(403, msg);
export const notFound = (msg = 'Не найдено') => new HttpError(404, msg);

const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
});

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

export function sendFile(res, status, body, headers) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

export function readJson(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const type = req.headers['content-type'] || '';
    if (!type.startsWith('application/json')) {
      reject(new HttpError(415, 'Ожидается Content-Type: application/json'));
      return;
    }
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
    req.on('end', () => {
      if (size === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(badRequest('Тело запроса должно быть JSON-объектом'));
          return;
        }
        resolve(parsed);
      } catch {
        reject(badRequest('Некорректный JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const idx = part.indexOf('=');
        return idx < 0 ? [part, ''] : [part.slice(0, idx), decodeURIComponent(part.slice(idx + 1))];
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
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      return { ...route, params };
    }
    return null;
  };
  return { add, match };
}
