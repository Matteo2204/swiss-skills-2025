import {Injectable, WritableSignal, computed, effect, signal} from '@angular/core';
import {IpcService} from './ipc.service';
import {ToastService} from './toastService';
import {overrideBaseUrl} from '../../../shared/api/lawnmower-api';

export type DefaultView = 'overview' | 'battery' | 'map' | 'messages' | 'remote';

export interface AppConfig {
  BaseUrl: string;
  LiveRangeSeconds: number;        // [60, 3600]
  HistoryRangeHours: number;       // [1, 168]
  BatteryLowThreshold: number;     // [1, 50]
  StuckThresholdMinutes: number;   // [1, 120]
  RefreshIntervalSeconds: number;  // [1, 30]
  DefaultView: DefaultView;
}

interface ReadResultOk {
  ok: true;
  path?: string;
  config: Partial<AppConfig>;
  invalid?: boolean;
  missing?: boolean;
}
interface ReadResultErr { ok: false; error?: string }
type ReadResult = ReadResultOk | ReadResultErr;

interface WriteResultOk { ok: true; path?: string }
interface WriteResultErr { ok: false; error?: string }
type WriteResult = WriteResultOk | WriteResultErr;

@Injectable({ providedIn: 'root' })
export class AppConfigService {
  // Signals for consumers
  private readonly _config: WritableSignal<AppConfig> = signal<AppConfig>(defaults());
  readonly config = computed<AppConfig>(() => this._config());
  readonly baseUrl = computed<string>(() => this._config().BaseUrl);
  readonly refreshIntervalSeconds = computed<number>(() => this._config().RefreshIntervalSeconds);
  readonly invalidReset = signal<boolean>(false); // true when file invalid and defaults applied

  constructor(private readonly ipc: IpcService, private readonly toast: ToastService) {
    // Kick off load on service creation
    void this.load();

    // Keep API client base URL in sync
    effect(() => {
      const url = this.baseUrl();
      try { overrideBaseUrl(url); } catch { /* ignore */ }
    });
  }

  async load(): Promise<void> {
    try {
      const res = await this.ipc.invoke<ReadResult>('config:read');
      if (!res?.ok) throw new Error((res as any)?.error || 'READ_FAILED');
      const merged = applyClampAndMerge(res.config);
      this._config.set(merged);
      const wasInvalid = !!(res as ReadResultOk).invalid;
      this.invalidReset.set(wasInvalid);
      if (wasInvalid) {
        // Non-intrusive banner responsibility is on the viewer; also show a soft toast
        this.toast.warning('Config non valido: reimpostati i default');
      }
    } catch (err: any) {
      // On any unexpected error, keep defaults and surface info
      this.invalidReset.set(true);
      this._config.set(defaults());
      this.toast.error('Impossibile leggere la config: usati i default');
    }
  }

  async save(next: AppConfig): Promise<boolean> {
    const clamped = clamp(next);
    try {
      const res = await this.ipc.invoke<WriteResult>('config:write', { json: clamped });
      if (!res?.ok) throw new Error((res as any)?.error || 'WRITE_FAILED');
      this._config.set(clamped);
      this.invalidReset.set(false);
      this.toast.success('Configurazione salvata');
      return true;
    } catch (err: any) {
      this.toast.error('Salvataggio configurazione non riuscito');
      return false;
    }
  }
}

// Defaults and clamps
function defaults(): AppConfig {
  return {
    BaseUrl: 'http://localhost:3000',
    LiveRangeSeconds: 300,
    HistoryRangeHours: 24,
    BatteryLowThreshold: 10,
    StuckThresholdMinutes: 10,
    RefreshIntervalSeconds: 5,
    DefaultView: 'overview',
  };
}

function applyClampAndMerge(raw: Partial<AppConfig>): AppConfig {
  const d = defaults();
  return {
    BaseUrl: typeof raw.BaseUrl === 'string' && raw.BaseUrl.trim() ? raw.BaseUrl.trim() : d.BaseUrl,
    LiveRangeSeconds: clampRange(num(raw.LiveRangeSeconds, d.LiveRangeSeconds), 60, 3600),
    HistoryRangeHours: clampRange(num(raw.HistoryRangeHours, d.HistoryRangeHours), 1, 168),
    BatteryLowThreshold: clampRange(num(raw.BatteryLowThreshold, d.BatteryLowThreshold), 1, 50),
    StuckThresholdMinutes: clampRange(num(raw.StuckThresholdMinutes, d.StuckThresholdMinutes), 1, 120),
    RefreshIntervalSeconds: clampRange(num(raw.RefreshIntervalSeconds, d.RefreshIntervalSeconds), 1, 30),
    DefaultView: isDefaultView(raw.DefaultView) ? raw.DefaultView! : d.DefaultView,
  };
}

function clamp(raw: AppConfig): AppConfig {
  return applyClampAndMerge(raw);
}

function isDefaultView(v: any): v is DefaultView {
  return v === 'overview' || v === 'battery' || v === 'map' || v === 'messages' || v === 'remote';
}

function num(v: any, def: number): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !isFinite(n)) return def;
  return Math.round(n);
}

function clampRange(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(v)));
}

