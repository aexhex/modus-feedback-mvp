// HTTP-клиенты внешних систем: REST Битрикс24 (входящий вебхук) и OData-интерфейс 1С.
// Без внешних зависимостей — встроенный fetch. Ошибки приводятся к понятному тексту для журнала.

const TIMEOUT_MS = 10_000;
const B24_PAGE = 50; // Битрикс24 отдаёт списки страницами по 50 записей
const B24_MAX_PAGES = 100;

export class IntegrationError extends Error {}

async function fetchJson(url, init) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? 'нет ответа за 10 секунд' : 'сервер недоступен';
    throw new IntegrationError(`${new URL(url).host}: ${reason}`);
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new IntegrationError(`${new URL(url).host}: ответ не в формате JSON (HTTP ${res.status})`);
  }
  return { status: res.status, body };
}

/** Вызов метода REST Битрикс24: POST {webhook}{method}.json, ответ { result } или { error }. */
export async function b24Call(webhookUrl, method, params = {}) {
  const { status, body } = await fetchJson(`${webhookUrl}${method}.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (body?.error) throw new IntegrationError(`Битрикс24 ${method}: ${body.error_description || body.error}`);
  if (status >= 400 || !body || !('result' in body)) throw new IntegrationError(`Битрикс24 ${method}: HTTP ${status}`);
  return body;
}

/** Полный список: Битрикс24 возвращает next — смещение следующей страницы. */
export async function b24List(webhookUrl, method, params = {}) {
  const items = [];
  let start = 0;
  for (let page = 0; page < B24_MAX_PAGES; page += 1) {
    const body = await b24Call(webhookUrl, method, { ...params, start });
    items.push(...(Array.isArray(body.result) ? body.result : []));
    if (body.next === undefined || body.next === null) return items;
    start = body.next;
  }
  throw new IntegrationError(`Битрикс24 ${method}: больше ${B24_PAGE * B24_MAX_PAGES} записей`);
}

/** GET к OData 1С: {base}{resource}?$format=json..., ответ { value: [...] }. */
export async function onecGet(onec, resource, query = {}) {
  const url = new URL(encodeURI(resource), onec.url);
  for (const [key, value] of Object.entries({ $format: 'json', ...query })) url.searchParams.set(key, value);
  const headers = { accept: 'application/json' };
  if (onec.user) headers.authorization = `Basic ${Buffer.from(`${onec.user}:${onec.password ?? ''}`).toString('base64')}`;
  const { status, body } = await fetchJson(url.href, { headers });
  if (status === 401) throw new IntegrationError('1С: неверный логин или пароль');
  if (status >= 400) throw new IntegrationError(`1С ${resource}: HTTP ${status}${body?.['odata.error']?.message?.value ? ` — ${body['odata.error'].message.value}` : ''}`);
  if (!Array.isArray(body?.value)) throw new IntegrationError(`1С ${resource}: в ответе нет списка value`);
  return body.value;
}
