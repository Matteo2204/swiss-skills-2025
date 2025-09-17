import {ChangeDetectionStrategy, Component, Inject, Optional, computed, inject, signal} from '@angular/core';
import {CommonModule} from '@angular/common';
import {RealtimeService} from '../services/realtime.service';
import {CLIENT_CONFIG, ClientConfig} from '../services/client-config.token';
import {LawnmowerState} from '../../../../shared/api/lawnmower-api';

// Optional message counts interface (will be provided by the future message engine).
export interface OverviewMessageCounts {
  info: number;
  warn: number;
  error: number;
}

export interface OverviewMessagesProvider {
  // Should reflect current set (live-derived) without forcing reloads.
  counts(): OverviewMessageCounts;
}

@Component({
  selector: 'app-overview-header',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'app-overview-header d-block position-sticky top-0 bg-white border-bottom',
    style: 'z-index: 5;',
  },
  templateUrl: './overview-header.component.html',
  styleUrl: './overview-header.component.css',
})
export class OverviewHeaderComponent {
  readonly rt = inject(RealtimeService);

  // Optional config (BatteryLowThreshold). Defaults to 20; clamped to [5,50]
  private readonly cfg = inject(CLIENT_CONFIG, { optional: true }) as ClientConfig | null;
  private readonly DEFAULT_BATTERY_LOW_THRESHOLD = 20;

  // Optional message provider; absent until message engine lands
  constructor(@Optional() @Inject('OverviewMessagesProvider') private readonly msgProvider?: OverviewMessagesProvider) {}

  readonly batteryLevel = computed<number | null>(() => this.rt.battery()?.batteryLevel ?? null);
  readonly stateName = computed<string>(() => this.rt.state()?.stateName ?? '—');
  readonly stateCode = computed<LawnmowerState | null>(() => this.rt.state()?.state ?? null);

  readonly batteryLowThreshold = computed<number>(() => {
    const raw = this.cfg?.batteryLowThresholdPercent ?? this.DEFAULT_BATTERY_LOW_THRESHOLD;
    const clamped = Math.max(5, Math.min(50, Math.round(raw)));
    return clamped;
  });

  readonly isBatteryLow = computed<boolean>(() => {
    const lvl = this.batteryLevel();
    return lvl !== null && lvl < this.batteryLowThreshold();
  });

  readonly isErrorState = computed<boolean>(() => this.stateCode() === LawnmowerState.Error || this.stateName().toLowerCase() === 'error');

  // Messages: total + breakdown (fallback to zeros when provider is absent)
  private readonly countsSig = signal<OverviewMessageCounts>({ info: 0, warn: 0, error: 0 });
  readonly messageCounts = computed<OverviewMessageCounts>(() => {
    try {
      const c = this.msgProvider?.counts();
      return c ? c : this.countsSig();
    } catch {
      return this.countsSig();
    }
  });
  readonly totalMessages = computed<number>(() => {
    const c = this.messageCounts();
    return (c.info | 0) + (c.warn | 0) + (c.error | 0);
  });
}
