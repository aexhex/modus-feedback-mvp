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
  installButtons.add(btn);
  return btn;
}
