import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractKeys } from '../scripts/i18n-extract.mjs';
import { createTranslator } from '../public/js/i18n-core.js';
import kk from '../public/js/i18n/kk.js';
import en from '../public/js/i18n/en.js';

const placeholders = (s) => [...s.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(',');

describe('словари перевода', () => {
  it('каждая русская строка интерфейса переведена на казахский и английский', async () => {
    const keys = await extractKeys();
    assert.ok(keys.length > 500, `найдено строк: ${keys.length}`);
    for (const [name, dict] of [['kk', kk], ['en', en]]) {
      const missing = keys.filter((k) => !(k in dict));
      assert.deepEqual(missing, [], `${name}: нет перевода`);
    }
  });

  it('подстановки {1}, {2}… совпадают в оригинале и переводе', () => {
    for (const [name, dict] of [['kk', kk], ['en', en]]) {
      for (const [key, value] of Object.entries(dict)) {
        assert.equal(placeholders(value), placeholders(key), `${name}: «${key}»`);
        assert.ok(value.trim().length > 0, `${name}: пустой перевод «${key}»`);
      }
    }
  });

  it('в английском словаре нет русского текста, кроме названий языков и ролей для CSV', () => {
    const allowed = ['Русский', 'Қазақша', 'сотрудник', 'ответственный', 'руководитель', 'администратор'];
    for (const [key, value] of Object.entries(en)) {
      const rest = allowed.reduce((s, word) => s.replaceAll(word, ''), value);
      assert.ok(!/[А-Яа-яЁё]/.test(rest), `en: «${key}» → «${value}»`);
    }
  });
});

describe('переводчик', () => {
  const t = createTranslator(en);

  it('переводит точную фразу и сохраняет пробелы по краям', () => {
    assert.equal(t('Главная'), 'Home');
    assert.equal(t('  Сохранить '), '  Save ');
  });

  it('подставляет значения в шаблон и переводит известные подстановки', () => {
    assert.equal(t('Найдено: 12'), 'Found: 12');
    assert.equal(t('Статус: Новое → На рассмотрении'), 'Status: New → In review');
  });

  it('переводит фразы из частей через «·», «—» и «:»', () => {
    assert.equal(t('Обучение · Закупки'), 'Training · Procurement');
    assert.equal(t('Оперативность · Продажи · у кого так же: 2'), 'Responsiveness · Sales · same for: 2');
    assert.equal(t('Закрыто: 1'), 'Closed: 1');
  });

  it('понимает строчную форму слова из словаря', () => {
    assert.equal(t('Срок первого ответа в рабочих днях: высокий — 1, низкий — 5'), 'First response time in working days: high — 1, low — 5');
  });

  it('не трогает пользовательский текст и строки без кириллицы', () => {
    assert.equal(t('В бухгалтерию приходят счета без номера договора'), null);
    assert.equal(t('A-003'), null);
    assert.equal(t(''), null);
  });
});
