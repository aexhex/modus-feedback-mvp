// Клиент API: конверт { ok, data, error } → данные или исключение с понятным текстом.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
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
export const post = (path, body = {}) => api('POST', path, body);
export const patch = (path, body = {}) => api('PATCH', path, body);
export const del = (path) => api('DELETE', path);

export const qs = (params) => {
  const entries = Object.entries(params).filter(([, v]) => v !== '' && v !== undefined && v !== null && v !== false);
  return entries.length ? `?${new URLSearchParams(entries)}` : '';
};
