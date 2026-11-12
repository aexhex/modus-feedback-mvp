// Настройки подключения к Битрикс24 и 1С УТ.
// Источник — переменные окружения (адрес вебхука и пароль 1С — секреты, в базе и интерфейсе их нет).
// Режимы: live — настоящий портал / база 1С; demo — встроенный демо-портал на этом же сервере
// (только в демо-режиме, когда переменные не заданы); off — интеграция выключена, вызовы пишутся в журнал.
import { randomBytes } from 'node:crypto';

export const DEMO_PORTAL_PREFIX = '/demo-portal';
// Демо-портал не секретен: он открыт только в демо-режиме и знает лишь синтетических пользователей.
export const DEMO_CLIENT_ID = 'local.golos-demo';
export const DEMO_CLIENT_SECRET = 'demo-secret';
// Сервер авторизации облачного Битрикс24 — общий для всех порталов.
const B24_OAUTH_SERVER = 'https://oauth.bitrix.info/oauth/token/';

const withSlash = (url) => (url.endsWith('/') ? url : `${url}/`);

function validUrl(value, name) {
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name}: неверный адрес`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${name}: нужен адрес http(s)`);
  return withSlash(url.href);
}

/**
 * @param {{ env?: Record<string, string|undefined>, demoMode?: boolean, overrides?: object }} options
 * overrides — те же значения, что в переменных окружения, но из кода (тесты).
 */
export function readIntegrationConfig({ env = process.env, demoMode = false, overrides = {} } = {}) {
  const pick = (key, envKey) => (key in overrides ? overrides[key] : env[envKey]) || null;
  const b24WebhookUrl = validUrl(pick('b24WebhookUrl', 'B24_WEBHOOK_URL'), 'B24_WEBHOOK_URL');
  const onecODataUrl = validUrl(pick('onecODataUrl', 'ONEC_ODATA_URL'), 'ONEC_ODATA_URL');
  const exportToken = pick('onecExportToken', 'ONEC_EXPORT_TOKEN');
  const clientId = pick('b24ClientId', 'B24_CLIENT_ID');
  const clientSecret = pick('b24ClientSecret', 'B24_CLIENT_SECRET');
  if (Boolean(clientId) !== Boolean(clientSecret)) throw new Error('B24_CLIENT_ID и B24_CLIENT_SECRET задаются вместе');
  if (clientId && !b24WebhookUrl) throw new Error('Вход через Битрикс24 (B24_CLIENT_ID) требует B24_WEBHOOK_URL — адрес портала');
  return {
    b24: b24WebhookUrl
      ? { mode: 'live', webhookUrl: b24WebhookUrl }
      : { mode: demoMode ? 'demo' : 'off', webhookUrl: null },
    onec: onecODataUrl
      ? { mode: 'live', odataUrl: onecODataUrl, user: pick('onecUser', 'ONEC_USER'), password: pick('onecPassword', 'ONEC_PASSWORD') }
      : { mode: demoMode ? 'demo' : 'off', odataUrl: null, user: null, password: null },
    // Вход через Битрикс24 (OAuth локального приложения). Портал — тот же, что в адресе вебхука.
    sso: clientId
      ? { mode: 'live', portal: new URL(b24WebhookUrl).origin, clientId, clientSecret }
      : (demoMode && !b24WebhookUrl ? { mode: 'demo', portal: null, clientId: DEMO_CLIENT_ID, clientSecret: DEMO_CLIENT_SECRET } : { mode: 'off' }),
    // Токен, с которым 1С забирает выгрузку обращений. В демо-режиме — случайный на время запуска.
    exportToken: exportToken ?? (demoMode ? `demo-${randomBytes(12).toString('hex')}` : null),
    // Адрес системы для ссылок в уведомлениях Битрикс24.
    publicUrl: pick('publicUrl', 'PUBLIC_URL'),
  };
}

// Адреса демо-портала известны только после запуска сервера (порт выбирается при listen).
export function resolveEndpoints(config, selfBase) {
  const demoBase = `${selfBase}${DEMO_PORTAL_PREFIX}`;
  return {
    b24: config.b24.mode === 'demo' ? `${demoBase}/b24/rest/1/demo/` : config.b24.webhookUrl,
    onec: config.onec.mode === 'demo' ? `${demoBase}/1c/odata/standard.odata/` : config.onec.odataUrl,
    publicUrl: (config.publicUrl ?? selfBase).replace(/\/$/, ''),
    // Вход: страница согласия открывается в браузере пользователя (у демо — относительный адрес,
    // чтобы работал и по IP в локальной сети), обмен кода и user.current — с сервера.
    sso: config.sso.mode === 'live'
      ? { authorize: `${config.sso.portal}/oauth/authorize/`, token: B24_OAUTH_SERVER, rest: `${config.sso.portal}/rest/`, domain: new URL(config.sso.portal).host }
      : { authorize: `${DEMO_PORTAL_PREFIX}/b24/oauth/authorize/`, token: `${demoBase}/b24/oauth/token/`, rest: `${demoBase}/b24/rest/`, domain: new URL(selfBase).host },
  };
}

// Для интерфейса администратора: только хост, без токена из адреса вебхука.
export function describeConfig(config) {
  const host = (url) => (url ? new URL(url).host : null);
  return {
    b24: { mode: config.b24.mode, host: host(config.b24.webhookUrl) },
    onec: { mode: config.onec.mode, host: host(config.onec.odataUrl) },
    sso: { mode: config.sso.mode },
    export: {
      enabled: Boolean(config.exportToken),
      demoToken: config.exportToken?.startsWith('demo-') ? config.exportToken : null,
    },
  };
}
