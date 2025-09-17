import {ChangeDetectionStrategy, Component, OnDestroy, OnInit, Injector, computed, effect, inject, signal} from '@angular/core';
import {CommonModule} from '@angular/common';
import {DeviceSelectorComponent} from '@shared/device-selector/device-selector.component';
import {OverviewHeaderComponent} from '@shared/overview-header/overview-header.component';
import {DeviceSelectionService} from '@shared/services/device-selection.service';
import {RealtimeService} from '@shared/services/realtime.service';
import {ToastService} from '../core/toastService';
import {AppConfigService} from '../core/app-config.service';
import {LawnmowerState, RemoteControlAction, ping as apiPing, remoteAction} from '../../../shared/api/lawnmower-api';

@Component({
  selector: 'app-remote-control',
  standalone: true,
  imports: [CommonModule, DeviceSelectorComponent, OverviewHeaderComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './remote-control.component.html',
  styleUrl: './remote-control.component.css'
})
export class RemoteControlComponent implements OnInit, OnDestroy {
  readonly ds = inject(DeviceSelectionService);
  readonly rt = inject(RealtimeService);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private readonly cfg = inject(AppConfigService, { optional: true }) as AppConfigService | null;

  // Busy states
  readonly busyAction = signal<RemoteControlAction | null>(null);
  readonly busyPing = signal<boolean>(false);

  // Device reachability via ping
  readonly deviceOnline = signal<boolean | null>(null);
  private pingTimer: any = null;

  // Current state code from live feed (null when unknown)
  private readonly stateCode = computed<LawnmowerState | null>(() => this.rt.state()?.state ?? null);

  // Disable all actions when no device selected or device is offline (based on ping)
  readonly actionsGloballyDisabled = computed<boolean>(() => !this.ds.hasSelection() || this.deviceOnline() !== true);

  // Enablement rules based on current mower state (minimal, non-invasive assumptions)
  readonly canStart = computed<boolean>(() => {
    const s = this.stateCode();
    return s === LawnmowerState.Paused || s === LawnmowerState.StationChargingCompleted;
  });
  readonly canStop = computed<boolean>(() => {
    const s = this.stateCode();
    return s === LawnmowerState.Mowing || s === LawnmowerState.ReturningToStation;
  });
  readonly canHome = computed<boolean>(() => {
    const s = this.stateCode();
    return s === LawnmowerState.Mowing || s === LawnmowerState.Paused;
  });
  readonly canAckError = computed<boolean>(() => this.stateCode() === LawnmowerState.Error);

  // Convenience for template
  readonly RemoteControlAction = RemoteControlAction;

  ngOnInit(): void {
    // Auto-ping on selection and periodically to reflect device reachability
    effect(() => {
      const id = this.ds.selectedId();
      this.setupPingTimer(id);
    }, { injector: this.injector });
  }

  ngOnDestroy(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  async onPing(): Promise<void> {
    const id = this.ds.selectedId();
    if (id == null) { this.toast.info('Seleziona un dispositivo'); return; }
    if (this.busyAction()) return; // avoid overlap
    this.busyPing.set(true);
    try {
      await apiPing(id);
      this.deviceOnline.set(true);
      this.toast.success('Ping OK');
    } catch (e: any) {
      const msg = e?.message || 'Ping fallito';
      this.deviceOnline.set(false);
      this.toast.error(msg);
    } finally {
      this.busyPing.set(false);
    }
  }

  async onAction(action: RemoteControlAction, confirmLabel: string): Promise<void> {
    const id = this.ds.selectedId();
    if (id == null) { this.toast.info('Seleziona un dispositivo'); return; }
    if (this.actionsGloballyDisabled()) return;
    if (this.busyPing() || this.busyAction() !== null) return;

    // Minimal confirmation to avoid accidental triggers
    const ok = window.confirm(`Confermi ${confirmLabel}?`);
    if (!ok) return;

    this.busyAction.set(action);
    try {
      await remoteAction(id, action);
      this.toast.success('Comando inviato');
      // No optimistic update: wait for live update from hub before any UI reflects state changes
    } catch (e: any) {
      const msg = e?.message || 'Operazione non riuscita';
      this.toast.error(msg);
    } finally {
      this.busyAction.set(null);
    }
  }

  // --- Helpers ---
  private setupPingTimer(id: number | null): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (!id) { this.deviceOnline.set(null); return; }
    const doPing = async () => {
      try {
        await apiPing(id);
        this.deviceOnline.set(true);
      } catch {
        this.deviceOnline.set(false);
      }
    };
    // immediate ping
    void doPing();
    // periodic ping aligned to refresh interval (min 1s, max 30s)
    const sec = this.cfg?.refreshIntervalSeconds() ?? 5;
    const ms = Math.min(Math.max((sec * 1000) || 5000, 1000), 30000);
    this.pingTimer = setInterval(doPing, ms);
  }
}
