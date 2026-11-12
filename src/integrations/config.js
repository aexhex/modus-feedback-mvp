// Настройки подключения к Битрикс24 и 1С УТ.
// Источник — переменные окружения (адрес вебхука и пароль 1С — секреты, в базе и интерфейсе их нет).
// Режимы: live — настоящий портал / база 1С; demo — встроенный демо-портал на этом же сервере
// (только в демо-режиме, когда переменные не заданы); off — интеграция выключена, вызовы пишутся в журнал.
import { randomBytes } from 'node:crypto';

export const DEMO_PORTAL_PREFIX = '/demo-portal';
// Демо-портал не секретен: он открыт только в демо-режиме и знает лишь синтетических пользователей.
export const DEMO_CLIENT_ID = 'local.golos-demo';
export const DEMO_CLIENT_SECRET = 'demo-secret';
export const DEMO_MAIL_FROM = 'golos@modus-demo.example';
const DEFAULT_CALENDAR_URL = 'https://isdayoff.ru/';
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
  const smtpHost = pick('smtpHost', 'SMTP_HOST');
  const smtpSecure = ['1', 'true', true].includes(pick('smtpSecure', 'SMTP_SECURE'));
  const smtpFrom = pick('smtpFrom', 'SMTP_FROM') || pick('smtpUser', 'SMTP_USER');
  if (smtpHost && !smtpFrom) throw new Error('SMTP_FROM: укажите адрес отправителя писем');
  const calendarUrl = validUrl(pick('calendarUrl', 'PROD_CALENDAR_URL'), 'PROD_CALENDAR_URL');
  const calendarCountry = pick('calendarCountry', 'PROD_CALENDAR_COUNTRY') ?? 'ru';
  if (!['ru', 'kz'].includes(calendarCountry)) throw new Error('PROD_CALENDAR_COUNTRY: ru или kz');
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
    // Письма-уведомления: почтовый сервер компании по SMTP; в демо-режиме — учебный сервер на этом компьютере.
    mail: smtpHost
      ? {
        mode: 'live', host: smtpHost, secure: smtpSecure, port: Number(pick('smtpPort', 'SMTP_PORT')) || (smtpSecure ? 465 : 587),
        user: pick('smtpUser', 'SMTP_USER'), password: pick('smtpPassword', 'SMTP_PASSWORD'), from: smtpFrom,
        allowPlain: ['1', 'true', true].includes(pick('smtpAllowPlain', 'SMTP_ALLOW_PLAIN')),
      }
      // Учебный ящик открыт без входа, поэтому рядом с настоящим порталом он не включается.
      : { mode: demoMode && !b24WebhookUrl ? 'demo' : 'off', from: DEMO_MAIL_FROM },
    // Производственный календарь: открытый сервис (по умолчанию isdayoff.ru); в демо-режиме — демо-портал.
    calendar: {
      mode: calendarUrl || !demoMode ? 'live' : 'demo', url: calendarUrl ?? DEFAULT_CALENDAR_URL, country: calendarCountry,
    },
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
    calendar: config.calendar.mode === 'demo' ? `${demoBase}/calendar/` : config.calendar.url,
    // Вход: страница согласия открывается в браузере пользователя (у демо — относительный адрес,
    // чтобы работал и по IP в локальной сети), обмен кода и user.current — с сервера.
    sso: config.sso.mode === 'live'
      ? {
        authorize: `${config.sso.portal}/oauth/authorize/`, token: B24_OAUTH_SERVER, rest: `${config.sso.portal}/rest/`,
        domain: new URL(config.sso.portal).host, origin: config.sso.portal,
      }
      // Демо-портал — на этом же сервере: его страница и система имеют один адрес (origin: null — свой).
      : {
        authorize: `${DEMO_PORTAL_PREFIX}/b24/oauth/authorize/`, token: `${demoBase}/b24/oauth/token/`, rest: `${demoBase}/b24/rest/`,
        domain: new URL(selfBase).host, origin: null,
      },
  };
}

// Для интерфейса администратора: только хост, без токена из адреса вебхука.
export function describeConfig(config) {
  const host = (url) => (url ? new URL(url).host : null);
  return {
    b24: { mode: config.b24.mode, host: host(config.b24.webhookUrl) },
    onec: { mode: config.onec.mode, host: host(config.onec.odataUrl) },
    sso: { mode: config.sso.mode },
    mail: { mode: config.mail.mode, host: config.mail.host ?? null },
    calendar: { mode: config.calendar.mode, host: host(config.calendar.url), country: config.calendar.country },
    export: {
      enabled: Boolean(config.exportToken),
      demoToken: config.exportToken?.startsWith('demo-') ? config.exportToken : null,
    },
  };
}
