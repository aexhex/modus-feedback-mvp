import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';

const silentLogger = { error: () => {} };

// Среда, 12:00 по Москве — фиксированное «сейчас», чтобы расчёт рабочих дней SLA был детерминированным.
export const TEST_NOW = '2026-11-11T09:00:00.000Z';

export async function startTestApp(options = {}) {
  let current = TEST_NOW;
  const uploadsDir = mkdtempSync(join(tmpdir(), 'fb-test-'));
  const { server, db, delivery, demoPortal } = createApp({
    dbPath: ':memory:', uploadsDir, publicDir: join(import.meta.dirname, '..', 'public'), logger: silentLogger,
    now: () => current, escalationIntervalMs: 0, ...options,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const userId = (name) => db.prepare('SELECT id FROM users WHERE name = ?').get(name).id;
  const ticketId = (code) => db.prepare('SELECT id FROM tickets WHERE code = ?').get(code).id;

  async function request(cookie, method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const isJson = (res.headers.get('content-type') || '').includes('json');
    return { status: res.status, headers: res.headers, json: isJson ? await res.json() : null, res };
  }

  async function as(name) {
    const r = await request(null, 'POST', '/api/session', { userId: userId(name) });
    const cookie = r.headers.get('set-cookie').split(';')[0];
    return {
      get: (path) => request(cookie, 'GET', path),
      post: (path, body = {}) => request(cookie, 'POST', path, body),
      patch: (path, body = {}) => request(cookie, 'PATCH', path, body),
      del: (path) => request(cookie, 'DELETE', path),
      raw: (path) => fetch(base + path, { headers: { cookie } }),
    };
  }

  const setNow = (iso) => { current = iso; };
  return { base, db, delivery, demoPortal, as, userId, ticketId, request, setNow, uploadsDir, close: () => new Promise((r) => server.close(r)) };
}
