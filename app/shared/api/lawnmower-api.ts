// Lawnmower API client (agnostic, fetch-based)
// Assumptions: using native fetch + FormData, no extra deps.
// Base URL can be overridden via overrideBaseUrl() and fetch via setFetch().

// ==========================
// Configuration & Utilities
// ==========================

// Default per CONTEXT.md: backend runs on http://localhost:3000
export let BASE_URL = 'http://localhost:3000';

export function overrideBaseUrl(url: string): void {
  // Normalize by trimming trailing slashes
  BASE_URL = url.replace(/\/+$/, '');
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let _fetch: FetchLike = (input, init) => (globalThis.fetch as any)(input, init);

export function setFetch(fetchImpl: FetchLike): void {
  _fetch = fetchImpl;
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

class APIError extends Error {
  readonly status: number;
  readonly url: string;
  constructor(message: string, status: number, url: string) {
    super(message);
    this.name = 'APIError';
    this.status = status;
    this.url = url;
  }
}

export class BadRequestError extends APIError {
  constructor(url: string, message = 'Bad request: invalid input.') {
    super(message, 400, url);
    this.name = 'BadRequestError';
  }
}

export class NotFoundError extends APIError {
  constructor(url: string, message = 'Not found: resource with given ID.') {
    super(message, 404, url);
    this.name = 'NotFoundError';
  }
}

export class ServiceUnavailableError extends APIError {
  constructor(url: string, message = 'Service unavailable: connection failed.') {
    super(message, 503, url);
    this.name = 'ServiceUnavailableError';
  }
}

function buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
  const url = new URL(BASE_URL + path);
  if (query) {
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    });
  }
  return url.toString();
}

async function handleErrors(res: Response): Promise<never> {
  const ct = res.headers.get('content-type') || '';
  let serverMessage = '';
  try {
    if (ct.includes('application/json')) {
      const data = await res.json();
      serverMessage = typeof data === 'string' ? data : (data?.message ?? JSON.stringify(data));
    } else {
      serverMessage = await res.text();
    }
  } catch {
    // ignore parse errors
  }
  const msg = serverMessage || `HTTP ${res.status}`;
  const url = res.url;
  if (res.status === 400) throw new BadRequestError(url, msg);
  if (res.status === 404) throw new NotFoundError(url, msg);
  if (res.status === 503) throw new ServiceUnavailableError(url, msg);
  throw new APIError(msg, res.status, url);
}

async function httpJson<T>(method: HttpMethod, path: string, body?: unknown, query?: Record<string, string | number | boolean | undefined>, okStatuses: number[] = [200]): Promise<T> {
  const url = buildUrl(path, query);
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
  const headers: HeadersInit = {};
  let payload: BodyInit | undefined = undefined;
  if (body !== undefined) {
    if (isFormData) {
      payload = body as any;
    } else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }

  const res = await _fetch(url, { method, headers, body: payload });
  if (!okStatuses.includes(res.status)) return handleErrors(res);

  // No content
  if (res.status === 204 || method === 'DELETE' || res.headers.get('content-length') === '0') {
    // Return type is generic; callers use <void> for no-content endpoints.
    // Cast is intentional to satisfy strict TS generics under Angular AOT.
    return undefined as unknown as T;
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    return (await res.json()) as T;
  }
  // Fallback: attempt JSON, otherwise text -> cast
  try {
    return (await res.json()) as T;
  } catch {
    return (await res.text()) as unknown as T;
  }
}

async function httpBlob(method: HttpMethod, path: string, query?: Record<string, string | number | boolean | undefined>, okStatuses: number[] = [200, 204]): Promise<Blob | null> {
  const url = buildUrl(path, query);
  const res = await _fetch(url, { method });
  if (!okStatuses.includes(res.status)) return handleErrors(res);
  if (res.status === 204) return null;
  return await res.blob();
}

// ==========================
// Types (from Swagger schemas)
// ==========================

export interface LawnmowerResponse {
  id: number; // int32
  name: string;
  address: string;
}

export interface LawnmowerRequest {
  name: string;
  address: string;
}

export interface BatteryResponse {
  timestamp: string; // date-time ISO
  batteryLevel: number; // double
}

export interface BatteryImportRequest {
  measurements: {
    timestamp: string; // date-time
    batteryLevel: number; // double
  }[];
}

export interface GpsResponse {
  timestamp: string; // date-time
  latitude: number; // double
  longitude: number; // double
}

export interface GpsImportRequest {
  measurements: {
    timestamp: string; // date-time
    latitude: number; // double
    longitude: number; // double
  }[];
}

export enum LawnmowerState {
  StationCharging = 0,
  StationChargingCompleted = 1,
  Mowing = 2,
  ReturningToStation = 3,
  Paused = 4,
  Error = 5,
}

export interface StateResponse {
  timestamp: string; // date-time
  state: LawnmowerState;
  stateName: string;
}

export interface StateImportRequest {
  measurements: {
    timestamp: string; // date-time
    state: LawnmowerState;
  }[];
}

export enum RemoteControlAction {
  Start = 0,
  Stop = 1,
  Home = 2,
  AckError = 3,
}

// ==========================
// API functions
// ==========================

// Lawn mowers
export async function getLawnmowers(): Promise<LawnmowerResponse[]> {
  return httpJson<LawnmowerResponse[]>('GET', '/api/lawnmowers');
}

export async function createLawnmower(req: LawnmowerRequest): Promise<LawnmowerResponse> {
  // Accept 201 (created)
  return httpJson<LawnmowerResponse>('POST', '/api/lawnmowers', req, undefined, [201]);
}

export async function getLawnmower(id: number): Promise<LawnmowerResponse> {
  return httpJson<LawnmowerResponse>('GET', `/api/lawnmowers/${encodeURIComponent(String(id))}`);
}

export async function updateLawnmower(id: number, req: LawnmowerRequest): Promise<LawnmowerResponse> {
  return httpJson<LawnmowerResponse>('PUT', `/api/lawnmowers/${encodeURIComponent(String(id))}`, req);
}

export async function deleteLawnmower(id: number): Promise<void> {
  // 204 on success
  await httpJson<void>('DELETE', `/api/lawnmowers/${encodeURIComponent(String(id))}`, undefined, undefined, [200, 204]);
}

// Avatar
export async function getAvatar(id: number): Promise<Blob | null> {
  return httpBlob('GET', `/api/lawnmowers/${encodeURIComponent(String(id))}/avatar`, undefined, [200, 204]);
}

export async function uploadAvatar(id: number, file: Blob): Promise<void> {
  const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/bmp']);
  if (file.type && !allowedTypes.has(file.type)) {
    // Pre-validate for a clearer message; server also validates
    throw new BadRequestError(`${BASE_URL}/api/lawnmowers/${id}/avatar`, 'Invalid avatar content type. Allowed: PNG, JPEG, BMP.');
  }
  const fd = new FormData();
  // Name must match swagger: "avatar"
  fd.append('avatar', file);
  await httpJson<void>('POST', `/api/lawnmowers/${encodeURIComponent(String(id))}/avatar`, fd, undefined, [200, 201]);
}

export async function deleteAvatar(id: number): Promise<void> {
  await httpJson<void>('DELETE', `/api/lawnmowers/${encodeURIComponent(String(id))}/avatar`, undefined, undefined, [200, 204]);
}

// Battery
export async function getBatteryCurrent(id: number): Promise<BatteryResponse> {
  return httpJson<BatteryResponse>('GET', `/api/lawnmowers/${encodeURIComponent(String(id))}/battery/current`);
}

export async function getBatteryHistory(id: number, fromISO: string, toISO: string): Promise<BatteryResponse[]> {
  return httpJson<BatteryResponse[]>('GET', `/api/lawnmowers/${encodeURIComponent(String(id))}/battery/history`, undefined, { from: fromISO, to: toISO });
}

export async function importBattery(id: number, body: BatteryImportRequest): Promise<void> {
  await httpJson<void>('POST', `/api/lawnmowers/${encodeURIComponent(String(id))}/battery/import`, body);
}

// GPS
export async function getGpsCurrent(id: number): Promise<GpsResponse> {
  return httpJson<GpsResponse>('GET', `/api/lawnmowers/${encodeURIComponent(String(id))}/gps/current`);
}

export async function getGpsHistory(id: number, fromISO: string, toISO: string): Promise<GpsResponse[]> {
  return httpJson<GpsResponse[]>('GET', `/api/lawnmowers/${encodeURIComponent(String(id))}/gps/history`, undefined, { from: fromISO, to: toISO });
}

export async function importGps(id: number, body: GpsImportRequest): Promise<void> {
  await httpJson<void>('POST', `/api/lawnmowers/${encodeURIComponent(String(id))}/gps/import`, body);
}

// State
export async function getStateCurrent(id: number): Promise<StateResponse> {
  return httpJson<StateResponse>('GET', `/api/lawnmowers/${encodeURIComponent(String(id))}/state/current`);
}

export async function getStateHistory(id: number, fromISO: string, toISO: string): Promise<StateResponse[]> {
  return httpJson<StateResponse[]>('GET', `/api/lawnmowers/${encodeURIComponent(String(id))}/state/history`, undefined, { from: fromISO, to: toISO });
}

export async function importState(id: number, body: StateImportRequest): Promise<void> {
  await httpJson<void>('POST', `/api/lawnmowers/${encodeURIComponent(String(id))}/state/import`, body);
}

// Remote Control
export async function ping(id: number): Promise<void> {
  await httpJson<void>('GET', `/api/lawnmowers/${encodeURIComponent(String(id))}/remote-control/ping`, undefined, undefined, [200]);
}

export async function remoteAction(id: number, action: RemoteControlAction): Promise<void> {
  await httpJson<void>('POST', `/api/lawnmowers/${encodeURIComponent(String(id))}/remote-control/action/${encodeURIComponent(String(action))}`, undefined, undefined, [200]);
}

// ==========================
// Manual smoke test (commented)
// ==========================
/*
export async function smokeTest(): Promise<void> {
  // Adjust base URL if needed
  // overrideBaseUrl('http://localhost:3000');

  // Lawn mowers
  const list = await getLawnmowers();
  console.log('Lawnmowers:', list.length);
  if (list[0]) {
    const lm = await getLawnmower(list[0].id);
    console.log('Get lawnmower OK:', lm.id);
  }

  // Create & update
  // const created = await createLawnmower({ name: 'Test LM', address: '192.168.0.10:1234' });
  // const updated = await updateLawnmower(created.id, { name: 'Test LM 2', address: '192.168.0.10:1234' });
  // await deleteLawnmower(created.id);

  // Avatar
  // const avatar = await getAvatar(list[0]?.id ?? 1);
  // console.log('Avatar exists?', !!avatar);
  // await deleteAvatar(list[0]?.id ?? 1);

  // Battery
  // await getBatteryCurrent(list[0]?.id ?? 1);
  // await getBatteryHistory(list[0]?.id ?? 1, new Date(Date.now()-86400000).toISOString(), new Date().toISOString());
  // await importBattery(list[0]?.id ?? 1, { measurements: [{ timestamp: new Date().toISOString(), batteryLevel: 75 }] });

  // GPS
  // await getGpsCurrent(list[0]?.id ?? 1);
  // await getGpsHistory(list[0]?.id ?? 1, new Date(Date.now()-86400000).toISOString(), new Date().toISOString());
  // await importGps(list[0]?.id ?? 1, { measurements: [{ timestamp: new Date().toISOString(), latitude: 47.0, longitude: 8.0 }] });

  // State
  // await getStateCurrent(list[0]?.id ?? 1);
  // await getStateHistory(list[0]?.id ?? 1, new Date(Date.now()-86400000).toISOString(), new Date().toISOString());
  // await importState(list[0]?.id ?? 1, { measurements: [{ timestamp: new Date().toISOString(), state: LawnmowerState.Mowing }] });

  // Remote control
  // await ping(list[0]?.id ?? 1);
  // await remoteAction(list[0]?.id ?? 1, RemoteControlAction.Start);
}
*/
