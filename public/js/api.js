// Клиент API: конверт { ok, data, error } → данные или исключение с понятным текстом.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(method, path, body, { background = false } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        // Фоновый опрос — не работа человека: по нему сессия не продлевается.
        ...(background ? { 'x-background': '1' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Нет связи с сервером');
  }
  const payload = await res.json().catch(() => null);
  if (!payload?.ok) throw new ApiError(res.status, payload?.error ?? `Ошибка ${res.status}`);
  return payload.data;
}

export const get = (path) => api('GET', path);
export const getInBackground = (path) => api('GET', path, undefined, { background: true });

// Для постраничных списков: данные вместе с метаданными { total, page, limit }.
export async function getWithMeta(path) {
  const res = await fetch(`/api${path}`, { credentials: 'same-origin' }).catch(() => null);
  const payload = res ? await res.json().catch(() => null) : null;
  if (!payload?.ok) throw new ApiError(res?.status ?? 0, payload?.error ?? 'Нет связи с сервером');
  return { data: payload.data, meta: payload.meta };
}
export const post = (path, body = {}) => api('POST', path, body);
export const patch = (path, body = {}) => api('PATCH', path, body);
export const del = (path) => api('DELETE', path);

export const qs = (params) => {
  const entries = Object.entries(params).filter(([, v]) => v !== '' && v !== undefined && v !== null && v !== false);
  return entries.length ? `?${new URLSearchParams(entries)}` : '';
};
