import {Injectable, WritableSignal, computed, effect, inject, signal} from '@angular/core';
import {CLIENT_CONFIG, type ClientConfig} from './client-config.token';
import {DeviceSelectionService} from './device-selection.service';
import {RealtimeService} from './realtime.service';
import {LawnmowerState, type BatteryResponse, type GpsResponse, type StateResponse} from '../../../../shared/api/lawnmower-api';

export type MessageCategory = 'info' | 'warn' | 'error';

export interface MessageItem {
  id: number;
  ts: number; // epoch ms
  category: MessageCategory;
  text: string;
  meta?: any;
}

// Assunzioni minime (non invasive):
// - Reset messaggi al cambio dispositivo selezionato.
// - Throttling 5s tra emissioni della stessa regola (chiave) per evitare spam.
// - Memoria massima 500 messaggi in ordine decrescente per timestamp.
@Injectable({ providedIn: 'root' })
export class MessageEngineService {
  private readonly rt = inject(RealtimeService);
  private readonly ds = inject(DeviceSelectionService);
  private readonly cfg = inject(CLIENT_CONFIG, { optional: true }) as ClientConfig | null;

  // Limits and thresholds
  // Keep a reasonable cap to avoid memory spikes; virtualization kicks in at 500
  private readonly MAX_MESSAGES = 2000;
  private readonly THROTTLE_MS = 5_000;
  private readonly DEFAULT_BATTERY_LOW_PCT = 20; // clamped [5,50]
  private readonly DEFAULT_STUCK_MIN = 5;        // minutes
  private readonly STUCK_DISTANCE_M = 3;         // < 3m in window ⇒ stuck

  // Public list of messages (descending by ts)
  private readonly listSig: WritableSignal<MessageItem[]> = signal<MessageItem[]>([]);
  readonly messages = computed<MessageItem[]>(() => this.listSig());

  // Computed counts for UI badges
  readonly countsComputed = computed(() => {
    const list = this.listSig();
    let info = 0, warn = 0, error = 0;
    for (const m of list) {
      if (m.category === 'info') info++; else if (m.category === 'warn') warn++; else if (m.category === 'error') error++;
    }
    return { info, warn, error };
  });

  // Internal state for edge/derivation
  private prevState: StateResponse | null = null;
  private batteryLowActive = false;
  private stuckActive = false;
  private gpsBuffer: { t: number; lat: number; lon: number }[] = [];
  private lastEmitByKey = new Map<string, number>();
  private nextId = 1;

  constructor() {
    // Reset when device selection changes
    effect(() => {
      const id = this.ds.selectedId();
      this.resetForSelection(id);
    });

    // Watch state changes
    effect(() => {
      const s = this.rt.state();
      if (!s) return;
      this.onState(s);
    });

    // Watch battery changes
    effect(() => {
      const b = this.rt.battery();
      if (!b) return;
      this.onBattery(b);
    });

    // Watch gps changes
    effect(() => {
      const g = this.rt.gps();
      if (!g) return;
      this.onGps(g);
    });
  }

  // Expose counts for OverviewHeaderComponent provider contract
  counts() { return this.countsComputed(); }

  clear(): void {
    this.listSig.set([]);
  }

  // --- Handlers ---
  private onState(cur: StateResponse): void {
    const prev = this.prevState;
    this.prevState = cur;

    // Rule 1: State change → info
    if (prev && prev.state !== cur.state) {
      this.emit('state-change', 'info', `State: ${prev.stateName} → ${cur.stateName}`, { prev, cur }, new Date(cur.timestamp).getTime());
    }

    const wasError = prev?.state === LawnmowerState.Error || (prev?.stateName?.toLowerCase() === 'error');
    const isError = cur.state === LawnmowerState.Error || (cur.stateName?.toLowerCase() === 'error');

    // Rule 4: Error entered
    if (!wasError && isError) {
      this.emit('error-entered', 'error', 'Error entered', { cur }, new Date(cur.timestamp).getTime());
    }
    // Rule 5: Error cleared
    if (wasError && !isError) {
      this.emit('error-cleared', 'info', 'Error cleared', { prev, cur }, new Date(cur.timestamp).getTime());
    }

    // If leaving mowing or entering mowing affects stuck logic, recompute immediately
    this.recomputeStuck();
  }

  private onBattery(b: BatteryResponse): void {
    const thr = this.batteryLowThreshold();
    const lvl = clampPct(b.batteryLevel);
    if (!this.batteryLowActive && lvl < thr) {
      this.batteryLowActive = true;
      // Rule 2: Battery low (edge-trigger)
      this.emit('battery-low', 'warn', `Battery low: ${lvl}% (< ${thr}%)`, { lvl, thr }, new Date(b.timestamp).getTime());
    } else if (this.batteryLowActive && lvl >= thr) {
      // reset edge gate (no message required by spec)
      this.batteryLowActive = false;
    }
  }

  private onGps(g: GpsResponse): void {
    const t = new Date(g.timestamp).getTime();
    this.gpsBuffer.push({ t, lat: g.latitude, lon: g.longitude });
    // Keep buffer within a safe window (stuckThreshold + 1 minute)
    const maxAgeMs = (this.stuckThresholdMin() + 1) * 60_000;
    const from = Date.now() - maxAgeMs;
    this.gpsBuffer = this.gpsBuffer.filter(p => p.t >= from);
    this.recomputeStuck();
  }

  private recomputeStuck(): void {
    const state = this.rt.state()?.state ?? null;
    const isMowing = state === LawnmowerState.Mowing;
    const now = Date.now();
    const fromTs = now - this.stuckThresholdMin() * 60_000;
    const pts = this.gpsBuffer.filter(p => p.t >= fromTs && p.t <= now);
    let dist = 0;
    for (let i = 1; i < pts.length; i++) dist += haversineM(pts[i - 1], pts[i]);
    const isStuck = isMowing && pts.length >= 2 && dist < this.STUCK_DISTANCE_M;

    if (isStuck && !this.stuckActive) {
      this.stuckActive = true;
      // Rule 3: Possible stuck (edge when not already active)
      this.emit('stuck-start', 'warn', 'Possible stuck', { distM: Math.round(dist) });
    } else if (!isStuck && this.stuckActive) {
      this.stuckActive = false;
      // Rule 6: Resumed movement
      this.emit('stuck-cleared', 'info', 'Resumed movement');
    }
  }

  // --- Helpers ---
  private emit(key: string, category: MessageCategory, text: string, meta?: any, ts?: number): void {
    const now = Date.now();
    const last = this.lastEmitByKey.get(key) ?? 0;
    if (now - last < this.THROTTLE_MS) return;
    this.lastEmitByKey.set(key, now);

    const msg: MessageItem = {
      id: this.nextId++,
      ts: ts ?? now,
      category,
      text,
      meta,
    };
    const cur = this.listSig();
    const next = [msg, ...cur];
    // Keep at most MAX_MESSAGES, already in descending ts due to unshift
    if (next.length > this.MAX_MESSAGES) next.length = this.MAX_MESSAGES;
    this.listSig.set(next);
  }

  private batteryLowThreshold(): number {
    const raw = this.cfg?.batteryLowThresholdPercent ?? this.DEFAULT_BATTERY_LOW_PCT;
    return Math.max(5, Math.min(50, Math.round(raw)));
  }
  private stuckThresholdMin(): number {
    const raw = (this.cfg as any)?.stuckThresholdMinutes ?? this.DEFAULT_STUCK_MIN;
    const v = Math.max(1, Math.min(60, Math.round(raw)));
    return v;
  }

  private resetForSelection(_mowerId: number | null): void {
    // Clear local runtime/edge states
    this.prevState = null;
    this.batteryLowActive = false;
    this.stuckActive = false;
    this.gpsBuffer = [];
    this.lastEmitByKey.clear();
    this.listSig.set([]);
    this.nextId = 1;
  }
}

// Utilities
function clampPct(v: number | null | undefined): number {
  if (typeof v !== 'number' || !isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

// Haversine (meters)
function haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return R * c;
}
