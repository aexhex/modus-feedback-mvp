// Сценарий запасной видеозаписи (по локальному сценарию защиты): пять сильных моментов защиты, около двух минут.
import { test } from '@playwright/test';
import { copyFileSync, mkdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { openTicket } from './helpers.js';

const VOICE_DIR = 'data/voice';
const GAP_MS = 600;
const FALLBACK_MS = 5000;

// Длительность реплики по размеру файла: MP3 из npm run voice (48 кбит/с) или WAV из npm run voice:offline
// (16 бит, моно, 22 050 Гц). Без озвучки — пауза по умолчанию.
function clipMs(key) {
  const mp3 = `${VOICE_DIR}/${key}.mp3`;
  const wav = `${VOICE_DIR}/${key}.wav`;
  if (existsSync(mp3)) return Math.round((statSync(mp3).size * 8) / 48);
  if (existsSync(wav)) return Math.round(((statSync(wav).size - 44) / 44100) * 1000);
  return FALLBACK_MS;
}

// Реплики идут одна за другой: действия на экране выполняются, пока звучит текущая реплика.
// Момент начала каждой реплики записывается в timeline.json — по нему npm run video:voice накладывает звук.
function narrator(t0) {
  const timeline = [];
  let busyUntil = 0;
  const waitFree = async (page) => {
    const left = busyUntil - Date.now();
    if (left > 0) await page.waitForTimeout(left);
  };
  return {
    timeline,
    elapsed: () => Date.now() - t0,
    waitFree,
    async say(page, key) {
      await waitFree(page);
      timeline.push({ key, at: Date.now() - t0 });
      busyUntil = Date.now() + clipMs(key) + GAP_MS;
    },
  };
}

// Подпись поверх страницы: зритель видео понимает, какой момент сейчас показан.
async function caption(page, text) {
  await page.evaluate((t) => {
    let el = document.getElementById('video-caption');
    if (!el) {
      el = document.createElement('div');
      el.id = 'video-caption';
      Object.assign(el.style, {
        position: 'fixed', left: '50%', bottom: '24px', transform: 'translateX(-50%)', zIndex: 9999,
        background: 'rgba(8,39,66,.92)', color: '#fff', padding: '10px 18px', borderRadius: '10px',
        font: '600 18px/1.3 system-ui, sans-serif', maxWidth: '90%', textAlign: 'center', pointerEvents: 'none',
      });
      document.body.append(el);
    }
    el.textContent = t;
  }, text);
}

// Прокрутка так, чтобы блок оказался в середине экрана, а не под подписью.
const center = (locator) => locator.evaluate((el) => el.scrollIntoView({ block: 'center' }));

// Вход через экран выбора роли — так, как это делает пользователь.
async function enter(page, role, name) {
  const change = page.getByRole('button', { name: 'Сменить роль' });
  if (await change.count()) await change.click();
  await page.locator(`.role-card[data-role="${role}"]`).click();
  const user = page.locator('.user-card', { hasText: name });
  if (await user.count()) await user.first().click();
  await page.locator('.user-chip b').waitFor();
}

test('видеозапись пяти моментов защиты', async ({ page }) => {
  // Подготовка за кадром: администратор загружает оргструктуру из Битрикс24 — без неё задача из обращения
  // ждёт сопоставления ответственного (момент 5).
  const users = (await (await page.request.get('/api/demo-users')).json()).data.users;
  const admin = users.find((u) => u.role === 'admin');
  await page.request.post('/api/session', { data: { userId: admin.id } });
  await page.request.post('/api/admin/integrations/b24/org-apply', { data: {} });
  await page.request.delete('/api/session');

  const voice = narrator(Date.now());
  const say = (key) => voice.say(page, key);

  await page.goto('/');
  await page.locator('.role-card').first().waitFor();
  await caption(page, 'Голос сотрудника: у каждого обращения есть ответственный, срок и итог');
  await say('intro');

  // 1. Подача за минуту и подсказка похожих.
  await voice.waitFree(page);
  await enter(page, 'employee', 'Сотрудник офиса');
  await page.goto('/#/new');
  await caption(page, '1. Подача за минуту: система сама находит похожие обращения');
  await say('s1a');
  await page.getByLabel('Категория').selectOption({ label: 'Хранение документов' });
  await page.getByLabel('Кратко, о чём обращение').pressSequentially('Не найти актуальную инструкцию в общих папках', { delay: 25 });
  await page.getByLabel('Описание').fill('В общих папках несколько редакций инструкции, непонятно, какая актуальная.');
  await page.locator('.similar-item').first().waitFor();
  await voice.waitFree(page);
  await caption(page, 'Вместо дубля — «У меня тоже»: обращение A-019 получает поддержку');
  await say('s1b');
  await page.waitForTimeout(2500);
  await page.locator('.similar-item').first().getByRole('button', { name: 'У меня тоже' }).click();

  // 2. Просрочки видны сразу.
  await voice.waitFree(page);
  await enter(page, 'manager', 'Директор по развитию');
  await caption(page, '2. Ничего не теряется: просрочки видны руководителю сразу');
  await page.locator('figure.chart svg').waitFor();
  await say('s2a');
  await voice.waitFree(page);
  await say('s2b');
  // Плитка, а не ссылка из карточки подсказок с тем же текстом.
  await page.locator('a.kpi', { hasText: 'Просрочено по SLA' }).click();
  await page.locator('tbody tr').first().waitFor();
  await voice.waitFree(page);
  await openTicket(page, 'A-007');
  await caption(page, 'Нарушение срока фиксируется, руководителю и ответственному уходит уведомление');
  await center(page.getByText('Нарушен SLA').first());
  await say('s2c');

  // 3. Автор всегда получает ответ.
  await voice.waitFree(page);
  await enter(page, 'employee', 'Сотрудник офиса');
  await openTicket(page, 'A-017');
  await caption(page, '3. Автор всегда получает ответ — даже отказ с причиной');
  await say('s3a');
  await voice.waitFree(page);
  await center(page.locator('.rating'));
  await caption(page, 'Автор сам оценивает, решён ли вопрос');
  await say('s3b');
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Нет, не решён' }).click();
  await voice.waitFree(page);
  await page.goto('/#/board');
  await page.locator('.win').first().waitFor();
  await caption(page, 'Итоги внедрения: реализованные идеи видны всем');
  await say('s3c');

  // 4. Идеи коллег и голосование (у «Сотрудника офиса» все голоса уже розданы в демо-данных).
  await voice.waitFree(page);
  await enter(page, 'employee', 'Сотрудник закупок');
  await page.goto('/#/tickets?scope=feed&sort=votes');
  await page.locator('tbody tr').first().waitFor();
  await caption(page, '4. Идеи обсуждает вся компания: у каждого 5 голосов');
  await say('s4a');
  await page.waitForTimeout(2500);
  await page.locator('tbody tr', { hasText: 'A-014' }).click();
  await center(page.locator('.vote-stepper'));
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: 'Добавить голос' }).click();
  await page.locator('.vote-mine', { hasText: '1' }).waitFor();
  await center(page.locator('.vote-stepper'));
  await voice.waitFree(page);
  await say('s4b');

  // 5. Встроено в Битрикс24: задача из обращения и обратная связь по её статусу.
  await voice.waitFree(page);
  await enter(page, 'handler', 'Ответственный за договоры');
  await openTicket(page, 'A-009');
  await caption(page, '5. Принятое предложение уходит задачей в Битрикс24');
  await say('s5a');
  await page.locator('.more-actions summary').click();
  await center(page.locator('.more-actions'));
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Создать задачу в Битрикс24' }).click();
  await page.locator('.toast-success').last().waitFor();
  await page.locator('.more-actions').evaluate((d) => { d.open = true; });
  await center(page.locator('.more-actions'));
  await voice.waitFree(page);
  await page.getByRole('button', { name: 'Завершить задачу на демо-портале' }).click();
  await page.locator('.timeline', { hasText: 'подтвердите результат' }).waitFor();
  await caption(page, 'Задачу закрыли — система видит это и просит зафиксировать итог');
  await center(page.locator('.timeline').getByText('подтвердите результат').first());
  await say('s5b');
  await voice.waitFree(page);
  // Финал — на экране входа с логотипом, как в сценарии защиты.
  await page.request.delete('/api/session');
  await page.goto('/');
  await page.locator('.role-card').first().waitFor();
  await caption(page, 'Работающая система: 266 серверных тестов, 80 тестов интерфейса, аудит безопасности, нагрузка 10 000 обращений');
  await say('outro');
  await voice.waitFree(page);
  await page.waitForTimeout(800);

  const endAt = voice.elapsed();
  const video = page.video();
  await page.close();
  mkdirSync('docs/demo', { recursive: true });
  copyFileSync(await video.path(), 'docs/demo/demo.webm');
  mkdirSync(VOICE_DIR, { recursive: true });
  writeFileSync(`${VOICE_DIR}/timeline.json`, JSON.stringify({ endAt, clips: voice.timeline }, null, 2));
});
