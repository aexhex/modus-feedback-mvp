// Накладывает озвучку (data/voice/*.mp3 или *.wav по data/voice/timeline.json) на docs/demo/demo.webm.
// ffmpeg не нужен: видео проигрывается в Chromium, звук расставляется через Web Audio,
// а MediaRecorder записывает картинку со звуком в новый WebM. Запуск: npm run video:voice
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '..');
const VIDEO = join(ROOT, 'docs/demo/demo.webm');
const TIMELINE = join(ROOT, 'data/voice/timeline.json');
const RECORD_TIMEOUT_MS = 5 * 60 * 1000;
const TAIL_SEC = 1;

for (const file of [VIDEO, TIMELINE]) {
  if (!existsSync(file)) throw new Error(`Нет файла ${file}: сначала npm run voice и npm run video`);
}
const timeline = JSON.parse(readFileSync(TIMELINE, 'utf8'));
const source = readFileSync(VIDEO);

// Отдаём только видео и WAV-файлы реплик из timeline.json.
const allowed = new Map([['/video.webm', [source, 'video/webm']]]);
// Реплика — MP3 нейроголоса (npm run voice) или WAV голоса Windows (npm run voice:offline).
const clipFile = (key) => ['mp3', 'wav'].map((ext) => `${key}.${ext}`).find((name) => existsSync(join(ROOT, 'data/voice', name)));
for (const { key } of timeline.clips) {
  const name = clipFile(key);
  if (!name) throw new Error(`Нет озвучки реплики ${key}: запустите npm run voice`);
  allowed.set(`/${key}`, [readFileSync(join(ROOT, 'data/voice', name)), name.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav']);
}
const PAGE = '<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000"><video id="v" src="/video.webm" muted playsinline></video></body>';
allowed.set('/', [Buffer.from(PAGE), 'text/html; charset=utf-8']);

const server = createServer((req, res) => {
  const hit = allowed.get(req.url);
  if (!hit) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': hit[1], 'content-length': hit[0].length }).end(hit[0]);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(base + '/');
  const result = await page.evaluate(async ({ clips, endAt, timeoutMs, TAIL_SEC }) => {
    const video = document.getElementById('v');
    if (video.readyState < 1) {
      await new Promise((ok, fail) => {
        video.onloadedmetadata = ok;
        video.onerror = () => fail(new Error('Видео не открылось'));
      });
    }
    // Время сценария совпадает со временем видео (проверено по кадрам); после закрытия страницы
    // Playwright дописывает несколько секунд застывшего кадра — их отрезаем.
    const endSec = endAt / 1000 + TAIL_SEC;

    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    const buffers = await Promise.all(clips.map(async ({ key }) =>
      ctx.decodeAudioData(await (await fetch(`/${key}`)).arrayBuffer())));

    const stream = new MediaStream([...video.captureStream().getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9,opus', videoBitsPerSecond: 5_000_000 });
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((ok) => { recorder.onstop = ok; });

    await video.play();
    recorder.start(1000);
    const startAt = ctx.currentTime;
    clips.forEach(({ at }, i) => {
      const src = ctx.createBufferSource();
      src.buffer = buffers[i];
      src.connect(dest);
      src.start(startAt + at / 1000);
    });
    await Promise.race([
      new Promise((ok) => { video.ontimeupdate = () => video.currentTime >= endSec && ok(); video.onended = ok; }),
      new Promise((_, fail) => setTimeout(() => fail(new Error('Запись не завершилась вовремя')), timeoutMs)),
    ]);
    recorder.stop();
    video.pause();
    await stopped;
    const blob = new Blob(chunks, { type: 'video/webm' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { base64: btoa(binary), durationMs: Math.round(Math.min(video.currentTime, endSec) * 1000) };
  }, { clips: timeline.clips, endAt: timeline.endAt, timeoutMs: RECORD_TIMEOUT_MS, TAIL_SEC });

  const out = withDuration(Buffer.from(result.base64, 'base64'), result.durationMs);
  writeFileSync(VIDEO, out);
  console.log(`Готово: ${VIDEO} — ${(result.durationMs / 1000).toFixed(1)} с, ${(out.length / 1e6).toFixed(1)} МБ`);
} finally {
  await browser.close();
  server.close();
}

// MediaRecorder не пишет длительность в WebM, из-за чего плееры не дают перематывать.
// Добавляем элемент Duration (0x4489) в блок Info (0x1549A966) сегмента.
function withDuration(buf, durationMs) {
  const vint = (pos) => {
    const first = buf[pos];
    let len = 1;
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len += 1;
    let value = first & (0xff >> len);
    for (let i = 1; i < len; i += 1) value = value * 256 + buf[pos + i];
    return { len, value };
  };
  const idAt = (pos) => {
    const { len } = vint(pos);
    return { len, id: buf.subarray(pos, pos + len).toString('hex') };
  };
  let pos = 0;
  const header = idAt(pos);
  pos += header.len;
  const headerSize = vint(pos);
  pos += headerSize.len + headerSize.value;
  const segment = idAt(pos);
  if (segment.id !== '18538067') return buf;
  pos += segment.len;
  pos += vint(pos).len;
  while (pos < buf.length) {
    const el = idAt(pos);
    const size = vint(pos + el.len);
    const dataStart = pos + el.len + size.len;
    if (el.id === '1549a966') {
      const body = buf.subarray(dataStart, dataStart + size.value);
      if (body.includes(Buffer.from([0x44, 0x89]))) return buf;
      const duration = Buffer.alloc(11);
      duration.set([0x44, 0x89, 0x88]);
      duration.writeDoubleBE(durationMs, 3);
      const newSize = Buffer.alloc(8);
      newSize[0] = 0x01;
      newSize.writeUIntBE(size.value + duration.length, 2, 6);
      return Buffer.concat([buf.subarray(0, pos + el.len), newSize, body, duration, buf.subarray(dataStart + size.value)]);
    }
    pos = dataStart + size.value;
  }
  return buf;
}
