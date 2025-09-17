import {ChangeDetectionStrategy, Component, OnInit, Injector, computed, effect, inject, signal} from '@angular/core';
import {CommonModule} from '@angular/common';
import {DeviceSelectionService} from '@shared/services/device-selection.service';
import {LawnmowerState, StateResponse, getStateHistory} from '../../../../shared/api/lawnmower-api';

interface Interval {
  start: number; // ms epoch
  end: number;   // ms epoch
  state: LawnmowerState;
  stateName: string;
  durationMs: number;
}

interface DistItem { state: LawnmowerState; stateName: string; ms: number; pct: number; color: string; }

@Component({
  selector: 'app-state-analytics',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'd-block' },
  templateUrl: './state-analytics.component.html',
  styleUrl: './state-analytics.component.css',
})
export class StateAnalyticsComponent implements OnInit {
  private readonly ds = inject(DeviceSelectionService);
  private readonly injector = inject(Injector);

  // Defaults per CONTEXT.md when loader assente
  private readonly DEFAULT_HISTORY_RANGE_H = 24; // ore

  readonly fromInput = signal<string>(''); // yyyy-MM-ddTHH:mm (local)
  readonly toInput = signal<string>('');

  readonly isLoading = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  // Raw points and computed intervals within [from,to]
  private readonly points = signal<StateResponse[] | null>(null);
  readonly intervals = computed<Interval[]>(() => this.buildIntervals());

  // Distribution (percent by duration)
  readonly distribution = computed<DistItem[]>(() => this.buildDistribution());
  readonly hasData = computed<boolean>(() => (this.points() ?? []).length > 0 && this.intervals().length > 0);

  // Simple SVG viewport for bars
  readonly width = 760;
  readonly heightPerBar = 24;
  readonly barGap = 10;
  readonly padding = { top: 10, right: 16, bottom: 10, left: 160 };

  ngOnInit(): void {
    // Initialize defaults for inputs
    const now = Date.now();
    const from = new Date(now - this.DEFAULT_HISTORY_RANGE_H * 3_600_000);
    this.fromInput.set(this.toLocalInput(from));
    this.toInput.set(this.toLocalInput(new Date(now)));

    // Auto-load when selection available
    effect(() => {
      const mowerId = this.ds.selectedId();
      if (!mowerId) {
        this.points.set([]);
        return;
      }
      // Do not auto-fetch on every keystroke; only on selection change here.
      void this.reload();
    }, { injector: this.injector });
  }

  async reload(): Promise<void> {
    const mowerId = this.ds.selectedId();
    if (!mowerId) return;
    const fromIso = this.fromInput() ? new Date(this.fromInput()).toISOString() : new Date(Date.now() - this.DEFAULT_HISTORY_RANGE_H * 3_600_000).toISOString();
    const toIso = this.toInput() ? new Date(this.toInput()).toISOString() : new Date().toISOString();
    this.isLoading.set(true);
    this.error.set(null);
    try {
      const list = await getStateHistory(mowerId, fromIso, toIso);
      const sorted = list
        .map(p => ({ ...p }))
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      this.points.set(sorted);
      if (sorted.length === 0) this.error.set('404');
    } catch (e: any) {
      this.points.set([]);
      if (e?.status === 404) this.error.set('404');
      else this.error.set(String(e?.message || 'Errore caricamento'));
    } finally {
      this.isLoading.set(false);
    }
  }

  // --- Computations ---
  private buildIntervals(): Interval[] {
    const pts = this.points() ?? [];
    const from = this.fromInput() ? new Date(this.fromInput()).getTime() : (Date.now() - this.DEFAULT_HISTORY_RANGE_H * 3_600_000);
    const to = this.toInput() ? new Date(this.toInput()).getTime() : Date.now();
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];

    // Only consider points that fall inside [from, to]
    const inRange = pts.filter(p => {
      const t = new Date(p.timestamp).getTime();
      return t >= from && t <= to;
    });
    if (inRange.length === 0) return [];

    const out: Interval[] = [];
    for (let i = 0; i < inRange.length; i++) {
      const cur = inRange[i];
      const curTs = new Date(cur.timestamp).getTime();
      const nextTs = i < inRange.length - 1 ? new Date(inRange[i + 1].timestamp).getTime() : to;

      // Assunzione minima: se il primo punto è dopo 'from', iniziare da 'from' con lo stesso stato.
      const start = (i === 0 && curTs > from) ? from : Math.max(curTs, from);
      const end = Math.min(nextTs, to);
      if (end > start) {
        out.push({
          start,
          end,
          state: cur.state,
          stateName: cur.stateName,
          durationMs: end - start,
        });
      }
    }
    return out;
  }

  private buildDistribution(): DistItem[] {
    const iv = this.intervals();
    if (iv.length === 0) return [];
    const byState = new Map<number, { ms: number; name: string }>();
    for (const it of iv) {
      const acc = byState.get(it.state) ?? { ms: 0, name: it.stateName };
      acc.ms += it.durationMs;
      acc.name = it.stateName || acc.name;
      byState.set(it.state, acc);
    }
    const total = Array.from(byState.values()).reduce((s, x) => s + x.ms, 0) || 1;
    const items: DistItem[] = Array.from(byState.entries())
      .map(([state, v]) => ({
        state: state as LawnmowerState,
        stateName: v.name,
        ms: v.ms,
        pct: (v.ms / total) * 100,
        color: this.colorForState(state as LawnmowerState),
      }))
      .sort((a, b) => b.ms - a.ms);
    return items;
  }

  // --- View helpers ---
  readonly svgBars = computed(() => {
    const items = this.distribution();
    const innerW = this.width - this.padding.left - this.padding.right;
    const barH = this.heightPerBar;
    const gap = this.barGap;
    const height = this.padding.top + this.padding.bottom + items.length * (barH + gap) - gap;
    const bars = items.map((it, idx) => {
      const y = this.padding.top + idx * (barH + gap);
      const w = innerW * (Math.max(0, Math.min(100, it.pct)) / 100);
      return { x: this.padding.left, y, w, h: barH, color: it.color, label: `${it.stateName} — ${it.pct.toFixed(1)}%`, pct: it.pct, stateName: it.stateName };
    });
    return { width: this.width, height, bars, innerW };
  });

  trackByIdx(_i: number, _v: any) { return _i; }
  trackByState(_i: number, v: DistItem) { return v.state; }

  colorForState(s: LawnmowerState): string {
    switch (s) {
      case LawnmowerState.StationCharging: return 'var(--bs-success)';
      case LawnmowerState.StationChargingCompleted: return 'var(--bs-info)';
      case LawnmowerState.Mowing: return 'var(--bs-primary)';
      case LawnmowerState.ReturningToStation: return 'var(--bs-warning)';
      case LawnmowerState.Paused: return '#6c757d'; // neutral gray
      case LawnmowerState.Error: return 'var(--bs-danger)';
      default: return '#6c757d';
    }
  }

  fmtDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const out: string[] = [];
    if (hh) out.push(`${hh}h`);
    if (mm) out.push(`${mm}m`);
    if (!hh && !mm) out.push(`${ss}s`);
    return out.join(' ');
  }

  toLocalInput(d: Date): string {
    const pad = (n: number) => (n < 10 ? '0' + n : '' + n);
    const yyyy = d.getFullYear();
    const MM = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const mm = pad(d.getMinutes());
    return `${yyyy}-${MM}-${dd}T${hh}:${mm}`;
  }
}
