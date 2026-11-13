// Приложение на телефоне: установка на главный экран, работа без связи, плашка «Нет связи».
// Сервис-воркер работает только по HTTPS или на localhost — в рабочей установке это так;
// при открытии по http://<IP> в локальной сети сайт просто работает как обычно.
import { h } from './dom.js';

let installPrompt = null;
const installButtons = new Set();

const showInstall = () => installButtons.forEach((btn) => { btn.hidden = !installPrompt; });

export function setupPwa() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Без сервис-воркера нет только офлайн-режима и установки — сайт работает как обычно.
    });
  }
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    showInstall();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    showInstall();
  });

  const banner = h('div', { class: 'offline-banner', role: 'status', hidden: navigator.onLine },
    'Нет связи с сервером. Черновик нового обращения сохраняется на этом устройстве — отправьте его, когда связь появится.');
  document.body.prepend(banner);
  window.addEventListener('offline', () => { banner.hidden = false; });
  window.addEventListener('online', () => { banner.hidden = true; });
}

// Push на этом устройстве: нужны сервис-воркер, Push API и безопасный адрес (HTTPS или localhost).
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;

export async function currentPushSubscription() {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

/** Подписывает это устройство; @returns подписку в формате для сервера. */
export async function subscribePush(publicKey) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Браузер не разрешил уведомления — разрешите их в настройках сайта');
  const registration = await navigator.serviceWorker.ready;
  const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  return subscription.toJSON();
}

/** Отписывает это устройство; @returns адрес снятой подписки или null. */
export async function unsubscribePush() {
  const subscription = await currentPushSubscription().catch(() => null);
  if (!subscription) return null;
  await subscription.unsubscribe().catch(() => {});
  return subscription.endpoint;
}

// Кнопка появляется, только когда браузер готов установить приложение.
export function installButton() {
  const btn = h('button', {
    class: 'btn btn-ghost btn-sm install-btn', type: 'button', hidden: !installPrompt,
    onclick: async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      showInstall();
    },
  }, 'Установить приложение');
  // Шапка перерисовывается при каждом переходе: кнопки прежних страниц уже не в документе — забываем их.
  installButtons.forEach((old) => { if (!old.isConnected) installButtons.delete(old); });
  installButtons.add(btn);
  return btn;
}
