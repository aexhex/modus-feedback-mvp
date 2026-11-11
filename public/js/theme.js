// Тема применяется до отрисовки страницы (обычный скрипт в <head>), чтобы не было вспышки светлого фона.
// Выбор пользователя хранится в localStorage; без него берётся системная настройка.
(function applyTheme() {
  var stored = null;
  try {
    stored = localStorage.getItem('theme');
  } catch (error) {
    stored = null; // хранилище недоступно (приватный режим) — используем системную тему
  }
  var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = stored || (prefersDark ? 'dark' : 'light');
}());
