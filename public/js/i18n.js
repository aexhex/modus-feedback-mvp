// Язык интерфейса: русский (исходный), казахский, английский.
// Экраны пишутся по-русски; переводчик подменяет готовый текст интерфейса по словарю
// (точные фразы и шаблоны с подстановками вроде «Найдено: {1}»). Текст обращений, комментариев
// и полей ввода не переводится: это данные пользователей.
import kk from './i18n/kk.js';
import en from './i18n/en.js';
import { createTranslator } from './i18n-core.js';

const STORAGE_KEY = 'lang';
const LANGS = Object.freeze([
  { code: 'ru', label: 'RU', name: 'Русский', locale: 'ru-RU' },
  { code: 'kk', label: 'KZ', name: 'Қазақша', locale: 'kk-KZ' },
  { code: 'en', label: 'EN', name: 'English', locale: 'en-GB' },
]);
const DICTS = { kk, en };
const ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
// Пользовательский текст и служебные элементы не переводятся.
const SKIP_SELECTOR = 'script, style, textarea, [data-no-i18n], .text-block';

function currentLang() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (LANGS.some((l) => l.code === saved)) return saved;
  } catch {
    // Хранилище недоступно — остаётся русский.
  }
  return 'ru';
}

/** Локаль для дат и чисел текущего языка. */
export const locale = () => LANGS.find((l) => l.code === currentLang()).locale;

const lang = currentLang();
const translate = lang === 'ru' ? () => null : createTranslator(DICTS[lang]);

/** Перевод строки вне DOM (например, для window.confirm). */
export const t = (text) => translate(text) ?? text;

// Что уже переведено: чтобы перевод не переводился повторно, если он совпал с другим русским ключом.
const doneText = new WeakMap();
const doneAttr = new WeakMap();

function skipped(node) {
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return !el || Boolean(el.closest(SKIP_SELECTOR));
}

function translateTextNode(node) {
  if (doneText.get(node) === node.nodeValue || skipped(node)) return;
  const out = translate(node.nodeValue);
  if (out !== null && out !== node.nodeValue) {
    node.nodeValue = out;
    doneText.set(node, out);
  }
}

function translateAttrs(el) {
  // У полей ввода переводятся подсказки (placeholder, aria-label), но не содержимое.
  if (el.closest('[data-no-i18n], .text-block')) return;
  const done = doneAttr.get(el) ?? {};
  for (const name of ATTRS) {
    const value = el.getAttribute(name);
    if (value === null || done[name] === value) continue;
    const out = translate(value);
    if (out !== null && out !== value) {
      el.setAttribute(name, out);
      done[name] = out;
    }
  }
  doneAttr.set(el, done);
}

function translateTree(root) {
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  translateAttrs(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) translateTextNode(node);
    else translateAttrs(node);
  }
}

// Минимальный конструктор элемента: модуль подключается раньше dom.js и не зависит от него.
function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, val] of Object.entries(props)) {
    if (key === 'class') node.className = val;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), val);
    else node.setAttribute(key, val);
  }
  node.append(...children.flat());
  return node;
}

// Переключатель языка: RU · KZ · EN. Выбор сохраняется в браузере, страница перезагружается.
export function langSwitch() {
  return el('div', { class: 'lang-switch', role: 'group', 'aria-label': 'Язык интерфейса' },
    LANGS.map((l) => el('button', {
      type: 'button', class: `lang-btn ${l.code === lang ? 'active' : ''}`, lang: l.code, 'data-no-i18n': '',
      // Доступное имя содержит видимую подпись (WCAG 2.5.3): «EN — English».
      title: l.name, 'aria-label': `${l.label} — ${l.name}`, 'aria-pressed': String(l.code === lang),
      onclick: () => {
        if (l.code === lang) return;
        try {
          localStorage.setItem(STORAGE_KEY, l.code);
        } catch {
          return; // без хранилища выбор не сохранится — перезагрузка вернула бы русский
        }
        location.reload();
      },
    }, l.label)));
}

document.documentElement.lang = lang;
if (lang !== 'ru') {
  translateTree(document.documentElement);
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'childList') m.addedNodes.forEach(translateTree);
      else if (m.type === 'characterData') translateTextNode(m.target);
      else if (m.type === 'attributes') translateAttrs(m.target);
    }
  }).observe(document.documentElement, {
    childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS,
  });
}
