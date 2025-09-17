import {Injectable, Signal, WritableSignal, computed, effect, inject, signal} from '@angular/core';
import {environment} from '../../../environments/environment';
import {DeviceSelectionService} from './device-selection.service';
import type {BatteryResponse, GpsResponse, StateResponse} from '../../../../shared/api/lawnmower-api';
import {getBatteryCurrent, getGpsCurrent, getStateCurrent} from '../../../../shared/api/lawnmower-api';
import {timer, Subscription, Observable} from 'rxjs';
import {AppConfigService} from '../../core/app-config.service';
import {toObservable} from '@angular/core/rxjs-interop';

// Assunzione minima: nomi eventi hub = 'state', 'battery', 'gps'.
// Se differiscono, mantenere configurabile qui con minima invasività.
const HUB_EVENT_NAMES = {
  state: 'state',
  battery: 'battery',
  gps: 'gps',
} as const;

// Grace period in ms: esattamente 60s come da requisito.
const GRACE_MS = 60_000;

type ConnectionPhase = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'offline';

@Injectable({ providedIn: 'root' })
export class RealtimeService {
  private readonly selection = inject(DeviceSelectionService);

  // Last values + timestamps from live or pseudo-live (polling)
  readonly state: WritableSignal<StateResponse | null> = signal<StateResponse | null>(null);
  readonly battery: WritableSignal<BatteryResponse | null> = signal<BatteryResponse | null>(null);
  readonly gps: WritableSignal<GpsResponse | null> = signal<GpsResponse | null>(null);

  // Updated whenever any live or polling result arrives
  readonly lastUpdateTs: WritableSignal<number | null> = signal<number | null>(null);
  readonly lastUpdateIso: Signal<string> = computed(() => {
    const ts = this.lastUpdateTs();
    return ts ? new Date(ts).toISOString() : '—';
  });

  // Observables (shared, cold) for consumers preferring Rx style
  readonly state$: Observable<StateResponse | null> = toObservable(this.state);
  readonly battery$: Observable<BatteryResponse | null> = toObservable(this.battery);
  readonly gps$: Observable<GpsResponse | null> = toObservable(this.gps);
  readonly lastUpdate$: Observable<number | null> = toObservable(this.lastUpdateTs);

  // Connection + grace period handling
  private readonly phase: WritableSignal<ConnectionPhase> = signal<ConnectionPhase>('idle');
  private readonly disconnectedSinceTs: WritableSignal<number | null> = signal<number | null>(null);
  readonly inGracePeriod = computed<boolean>(() => {
    const d = this.disconnectedSinceTs();
    if (!d) return false;
    return (Date.now() - d) < GRACE_MS;
  });
  // Backend reachability: consider recent successful updates (hub or polling)
  private readonly backendReachable = computed<boolean>(() => {
    const ts = this.lastUpdateTs();
    if (!ts) return false;
    const sec = this.cfg?.refreshIntervalSeconds() ?? Math.round((environment.refreshIntervalMs ?? 3000) / 1000);
    const interval = Math.min(Math.max((sec * 1000) || 3000, 1000), 30000);
    const maxAge = Math.max(2000, interval * 2);
    return (Date.now() - ts) <= maxAge;
  });
  // Actions disabled solo durante grace o quando backend realmente non raggiungibile
  readonly actionsDisabled = computed<boolean>(() => this.inGracePeriod() || !this.backendReachable());
  // Banner offline visibile solo quando fuori grace e senza backend raggiungibile
  readonly offlineBannerVisible = computed<boolean>(() => !this.inGracePeriod() && !this.isConnected() && !this.backendReachable());

  // Derived booleans for UI/debug
  readonly isConnected = computed<boolean>(() => this.phase() === 'connected');
  readonly isConnecting = computed<boolean>(() => this.phase() === 'connecting');
  readonly isDisconnected = computed<boolean>(() => this.phase() === 'disconnected' || this.phase() === 'offline');

  // Hub connection handle (lazy/dynamic import to avoid bundle if disabled)
  private hub: any | null = null;
  private hubConn: any | null = null;

  // Polling fallback
  private pollingSub: Subscription | null = null;
  private lastPolledMowerId: number | null = null;
  private readonly cfg = inject(AppConfigService, { optional: true }) as AppConfigService | null;

  constructor() {
    // React to selection changes and (re)wire hub/polling accordingly
    effect(() => {
      const mowerId = this.selection.selectedId();
      void this.onMowerChanged(mowerId);
    });

    // Grace period expiration watcher
    effect(() => {
      if (!this.inGracePeriod() && this.phase() === 'disconnected') {
        // Finita la grace: se non riusciamo a raggiungere il backend (niente update recenti), segna offline
        // altrimenti rimani in stato degradato (disconnected) ma con polling attivo
        if (!this.backendReachable()) this.phase.set('offline');
      }
    });
  }

  // Called when user selects another mower, or clears selection
  private async onMowerChanged(mowerId: number | null): Promise<void> {
    // Stop previous streams
    this.stopPolling();
    await this.stopHub();
    this.disconnectedSinceTs.set(null);
    this.phase.set('idle');
    // Keep last known values until new ones arrive (as per requirement)

    if (!mowerId) return;

    // Try hub first if enabled, otherwise fallback to polling
    if (environment.realtimeEnabled) {
      const ok = await this.startHub(mowerId);
      if (!ok) this.startPolling(mowerId); // fallback
    } else {
      this.startPolling(mowerId);
    }
  }

  private async startHub(mowerId: number): Promise<boolean> {
    this.phase.set('connecting');
    try {
      if (!this.hub) {
        // Dynamic import; tree-shaken if realtime disabled
        this.hub = await import('@microsoft/signalr');
      }
      const { HubConnectionBuilder, LogLevel } = this.hub;
      // Build connection
      this.hubConn = new HubConnectionBuilder()
        .withUrl(environment.lawnmowerHubUrl + `?mowerId=${encodeURIComponent(String(mowerId))}`)
        .withAutomaticReconnect([0, 2000, 5000, 10000])
        .configureLogging(LogLevel.Information)
        .build();

      // Register handlers (assunzione: event names lowercase)
      this.hubConn.on(HUB_EVENT_NAMES.state, (payload: StateResponse) => this.onState(payload));
      this.hubConn.on(HUB_EVENT_NAMES.battery, (payload: BatteryResponse) => this.onBattery(payload));
      this.hubConn.on(HUB_EVENT_NAMES.gps, (payload: GpsResponse) => this.onGps(payload));

      this.hubConn.onclose((_err: any) => this.onHubDisconnected());
      this.hubConn.onreconnecting((_err: any) => this.onHubReconnecting());
      this.hubConn.onreconnected((_id: any) => this.onHubReconnected());

      await this.hubConn.start();
      this.phase.set('connected');
      this.disconnectedSinceTs.set(null);
      return true;
    } catch (e) {
      // Connection failed → start grace timer and fallback polling
      this.onHubDisconnected();
      return false;
    }
  }

  private async stopHub(): Promise<void> {
    if (this.hubConn) {
      try { await this.hubConn.stop(); } catch { /* noop */ }
      this.hubConn = null;
    }
  }

  private onHubDisconnected(): void {
    if (!this.disconnectedSinceTs()) this.disconnectedSinceTs.set(Date.now());
    // Enter disconnected (grace timer will flip to offline when expired)
    this.phase.set('disconnected');
    // If not already polling, start it for pseudo-live updates
    const mowerId = this.selection.selectedId();
    if (mowerId && !this.pollingSub) this.startPolling(mowerId);
  }

  private onHubReconnecting(): void {
    if (!this.disconnectedSinceTs()) this.disconnectedSinceTs.set(Date.now());
    this.phase.set('disconnected');
  }

  private onHubReconnected(): void {
    this.phase.set('connected');
    this.disconnectedSinceTs.set(null);
  }

  private onState(p: StateResponse): void {
    this.state.set(p);
    this.touchUpdate();
  }
  private onBattery(p: BatteryResponse): void {
    this.battery.set(p);
    this.touchUpdate();
  }
  private onGps(p: GpsResponse): void {
    this.gps.set(p);
    this.touchUpdate();
  }
  private touchUpdate(): void { this.lastUpdateTs.set(Date.now()); }

  private startPolling(mowerId: number): void {
    const sec = this.cfg?.refreshIntervalSeconds() ?? Math.round((environment.refreshIntervalMs ?? 3000) / 1000);
    const interval = Math.min(Math.max((sec * 1000) || 3000, 1000), 30000);
    this.lastPolledMowerId = mowerId;
    this.stopPolling();
    // Degraded, but still getting data
    // Keep phase as 'disconnected' (or 'offline' if grace expired); do not flip to 'connected'
    this.pollingSub = timer(0, interval).subscribe(async () => {
      if (this.lastPolledMowerId !== mowerId) return; // selection changed
      try {
        // Run in parallel, ignore individual failures
        const [s, b, g] = await Promise.allSettled([
          getStateCurrent(mowerId),
          getBatteryCurrent(mowerId),
          getGpsCurrent(mowerId),
        ]);
        if (s.status === 'fulfilled') this.state.set(s.value);
        if (b.status === 'fulfilled') this.battery.set(b.value);
        if (g.status === 'fulfilled') this.gps.set(g.value);
        if (
          (s.status === 'fulfilled') ||
          (b.status === 'fulfilled') ||
          (g.status === 'fulfilled')
        ) this.touchUpdate();
      } catch {
        // ignore
      }
    });
  }

  private stopPolling(): void {
    if (this.pollingSub) { this.pollingSub.unsubscribe(); this.pollingSub = null; }
  }
}
