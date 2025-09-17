/**
 * Smoke test for main REST API. No new deps; run with:
 *   ts-node --transpile-only tools/smoke_test.ts
 *
 * Steps:
 *  - login (admin/admin123)
 *  - create mower
 *  - read details
 *  - read current battery/gps/state
 *  - call analytics (distance, hours, efficiency, energy)
 *  - send start action (accept 503 in dev)
 *  - delete mower
 *
 * Base URL: from env SMOKE_BASE_URL | BASE_URL | API_BASE_URL | PORT, else http://localhost:3000
 */

import { setTimeout as sleep } from 'node:timers/promises';

type Json = any;

function baseUrl(): string {
  const envUrl = process.env.SMOKE_BASE_URL || process.env.BASE_URL || process.env.API_BASE_URL;
  if (envUrl && /^https?:\/\//i.test(envUrl)) return envUrl.replace(/\/$/, '');
  const port = process.env.PORT || '3000';
  return `http://localhost:${port}`;
}

async function request(method: string, path: string, opts: {
  headers?: Record<string, string>;
  json?: any;
  timeoutMs?: number;
} = {}): Promise<{ ok: boolean; status: number; body: Json; }> {
  const url = baseUrl() + path;
  const headers: Record<string, string> = { 'accept': 'application/json', ...(opts.headers || {}) };
  let body: any = undefined;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10000);
  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal } as any);
    const ct = res.headers.get('content-type') || '';
    const isJson = /application\/json/i.test(ct);
    const data = isJson ? await res.json().catch(() => ({})) : await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, body: data };
  } catch (e: any) {
    return { ok: false, status: 0, body: { error: String(e?.message || e) } };
  } finally {
    clearTimeout(t);
  }
}

function logStep(name: string, ok: boolean, extra?: string) {
  const icon = ok ? '✅' : '❌';
  const suffix = extra ? ` — ${extra}` : '';
  console.log(`${icon} ${name}${suffix}`);
}

async function main() {
  console.log(`[smoke] Base URL: ${baseUrl()}`);
  let failures = 0;

  // 1) Login
  let token: string | undefined;
  {
    const r = await request('POST', '/api/auth/login', { json: { username: 'admin', password: 'admin123', remember: true } });
    const ok = r.ok && r.body && r.body.ok === true && typeof r.body.token === 'string';
    if (!ok) failures++;
    else token = r.body.token;
    logStep('Login as admin', ok, ok ? 'token received' : `status=${r.status}`);
    if (!token) {
      console.log('[smoke] Cannot proceed without token. Exiting.');
      process.exit(failures === 0 ? 0 : 1);
      return;
    }
  }

  const authHeaders = (t: string) => ({ 'Authorization': `Bearer ${t}` });

  // 2) Create mower
  let mowerId: number | undefined;
  {
    const payload = {
      name: `smoke-${Date.now()}`,
      vendor: 'TestCo',
      model: 'T-1',
      serial_number: 'SN-SMOKE',
      firmware: '1.0',
      home_lat: 46.003, // provide so that gps/current has a point
      home_lon: 7.002,
    };
    const r = await request('POST', '/api/lawnmower', { headers: authHeaders(token!), json: payload });
    const ok = (r.status === 201 || r.ok) && r.body && Number.isFinite(Number(r.body.id));
    if (!ok) failures++;
    else mowerId = Number(r.body.id);
    logStep('Create mower', ok, ok ? `id=${mowerId}` : `status=${r.status}`);
  }

  if (!mowerId) {
    console.log('[smoke] Cannot proceed without mower id. Exiting.');
    process.exit(failures === 0 ? 0 : 1);
    return;
  }

  // 3) Read details
  {
    const r = await request('GET', `/api/lawnmower/${mowerId}`, { headers: authHeaders(token!) });
    const ok = r.ok && r.body && Number(r.body.id) === mowerId;
    if (!ok) failures++;
    logStep('Get mower details', ok, `status=${r.status}`);
  }

  // tiny pause to avoid race on view refresh
  await sleep(100);

  // 4) Read current endpoints (no auth required)
  {
    const b = await request('GET', `/api/lawnmower/${mowerId}/battery/current`);
    const g = await request('GET', `/api/lawnmower/${mowerId}/gps/current`);
    const s = await request('GET', `/api/lawnmower/${mowerId}/state/current`);
    const ok = b.ok && g.ok && s.ok;
    if (!ok) failures++;
    logStep('Get current (battery/gps/state)', ok, `status=${b.status}/${g.status}/${s.status}`);
  }

  // 5) Analytics
  {
    const d = await request('GET', `/api/lawnmower/${mowerId}/analytics/distance`);
    const h = await request('GET', `/api/lawnmower/${mowerId}/analytics/hours`);
    const e = await request('GET', `/api/lawnmower/${mowerId}/analytics/efficiency`);
    const n = await request('GET', `/api/lawnmower/${mowerId}/analytics/energy`);
    const ok = d.ok && h.ok && e.ok && n.ok;
    if (!ok) failures++;
    logStep('Analytics (distance/hours/efficiency/energy)', ok, `status=${d.status}/${h.status}/${e.status}/${n.status}`);
  }

  // 6) Action: start (auth required) — accept 200/202 or 503 when no connection
  {
    const r = await request('POST', `/api/lawnmower/${mowerId}/actions/start`, { headers: authHeaders(token!) });
    const ok = r.status === 200 || r.status === 202 || r.status === 503 || r.status === 504;
    if (!ok) failures++;
    logStep('Action start', ok, `status=${r.status}`);
  }

  // 7) Delete mower (auth required)
  {
    const r = await request('DELETE', `/api/lawnmower/${mowerId}`, { headers: authHeaders(token!) });
    const ok = r.ok && r.body && r.body.ok === true;
    if (!ok) failures++;
    logStep('Delete mower', ok, `status=${r.status}`);
  }

  const passed = failures === 0;
  console.log(`[smoke] Result: ${passed ? 'PASSED' : 'FAILED'} — failures=${failures}`);
  process.exit(passed ? 0 : 1);
}

// Kick off
main().catch((e) => {
  console.error('[smoke] Unhandled error:', e);
  process.exit(1);
});

