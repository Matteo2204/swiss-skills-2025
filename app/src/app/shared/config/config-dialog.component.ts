import {ChangeDetectionStrategy, Component, ElementRef, ViewChild, computed, inject, signal} from '@angular/core';
import {CommonModule} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {AppConfig, AppConfigService} from '../../core/app-config.service';

type Mode = 'view' | 'edit';

@Component({
  selector: 'app-config-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './config-dialog.component.html',
  styleUrl: './config-dialog.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfigDialogComponent {
  protected readonly cfg = inject(AppConfigService);

  @ViewChild('dlg', { static: true }) dlg!: ElementRef<HTMLDialogElement>;

  readonly mode = signal<Mode>('view');
  readonly busy = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  // Snapshot editable values (string/number)
  readonly BaseUrl = signal<string>('');
  readonly LiveRangeSeconds = signal<number>(300);
  readonly HistoryRangeHours = signal<number>(24);
  readonly BatteryLowThreshold = signal<number>(10);
  readonly StuckThresholdMinutes = signal<number>(10);
  readonly RefreshIntervalSeconds = signal<number>(5);
  readonly DefaultView = signal<'overview' | 'battery' | 'map' | 'messages' | 'remote'>('overview');

  // Validation helpers
  readonly v = {
    liveMin: 60, liveMax: 3600,
    histMin: 1, histMax: 168,
    batMin: 1, batMax: 50,
    stuckMin: 1, stuckMax: 120,
    refreshMin: 1, refreshMax: 30,
  } as const;

  readonly hasInvalid = computed<boolean>(() => {
    const s = this.snapshot();
    return !s.BaseUrl || !/^https?:\/\//i.test(s.BaseUrl)
      || s.LiveRangeSeconds < this.v.liveMin || s.LiveRangeSeconds > this.v.liveMax
      || s.HistoryRangeHours < this.v.histMin || s.HistoryRangeHours > this.v.histMax
      || s.BatteryLowThreshold < this.v.batMin || s.BatteryLowThreshold > this.v.batMax
      || s.StuckThresholdMinutes < this.v.stuckMin || s.StuckThresholdMinutes > this.v.stuckMax
      || s.RefreshIntervalSeconds < this.v.refreshMin || s.RefreshIntervalSeconds > this.v.refreshMax;
  });

  readonly showInvalidBanner = computed<boolean>(() => this.cfg.invalidReset());

  open(): void {
    this.reset();
    this.mode.set('view');
    this.dlg.nativeElement.showModal();
  }

  close(): void {
    if (this.busy()) return;
    this.dlg.nativeElement.close();
  }

  onEdit(): void { if (!this.busy()) this.mode.set('edit'); }
  onCancelEdit(): void {
    if (this.busy()) return;
    this.reset();
    this.mode.set('view');
  }

  async onSave(): Promise<void> {
    if (this.busy() || this.hasInvalid()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const ok = await this.cfg.save(this.snapshot());
      if (ok) this.dlg.nativeElement.close();
    } catch (e: any) {
      this.error.set(e?.message ?? 'Salvataggio non riuscito');
    } finally {
      this.busy.set(false);
    }
  }

  private reset(): void {
    const c = this.cfg.config();
    this.BaseUrl.set(c.BaseUrl);
    this.LiveRangeSeconds.set(c.LiveRangeSeconds);
    this.HistoryRangeHours.set(c.HistoryRangeHours);
    this.BatteryLowThreshold.set(c.BatteryLowThreshold);
    this.StuckThresholdMinutes.set(c.StuckThresholdMinutes);
    this.RefreshIntervalSeconds.set(c.RefreshIntervalSeconds);
    this.DefaultView.set(c.DefaultView);
    this.error.set(null);
    this.busy.set(false);
  }

  private snapshot(): AppConfig {
    return {
      BaseUrl: this.BaseUrl().trim(),
      LiveRangeSeconds: asInt(this.LiveRangeSeconds()),
      HistoryRangeHours: asInt(this.HistoryRangeHours()),
      BatteryLowThreshold: asInt(this.BatteryLowThreshold()),
      StuckThresholdMinutes: asInt(this.StuckThresholdMinutes()),
      RefreshIntervalSeconds: asInt(this.RefreshIntervalSeconds()),
      DefaultView: this.DefaultView(),
    };
  }
}

function asInt(v: any): number { return Math.max(0, Math.round(Number(v))); }
