import {AfterViewInit, ChangeDetectionStrategy, Component, Inject, OnDestroy, OnInit, Optional, ViewChild, ElementRef, Injector, computed, effect, inject, signal} from '@angular/core';
import {CommonModule} from '@angular/common';
import {DeviceSelectionService} from '@shared/services/device-selection.service';
import {RealtimeService} from '@shared/services/realtime.service';
import {CLIENT_CONFIG, ClientConfig} from '@shared/services/client-config.token';
import {LawnmowerState, BatteryResponse, getBatteryHistory} from '../../../../shared/api/lawnmower-api';
import Chart, { ChartDataset, Plugin } from 'chart.js/auto';

type TabId = 'latest' | 'history';

interface Point { t: number; v: number; }

@Component({
  selector: 'app-battery-trend',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'd-block' },
  templateUrl: './battery-trend.component.html',
  styleUrl: './battery-trend.component.css',
})
export class BatteryTrendComponent implements OnInit, AfterViewInit, OnDestroy {
  readonly ds = inject(DeviceSelectionService);
  readonly rt = inject(RealtimeService);
  private readonly cfg = inject(CLIENT_CONFIG, { optional: true }) as ClientConfig | null;
  private readonly injector = inject(Injector);

  // Defaults per CONTEXT.md when not provided by config loader
  private readonly DEFAULT_LIVE_RANGE_MIN = 15; // LiveRange (minuti)
  private readonly DEFAULT_HISTORY_RANGE_H = 24; // HistoryRange (ore)
  private readonly DEFAULT_BATTERY_LOW_THRESHOLD = 20; // percent

  // UI state
  readonly activeTab = signal<TabId>('latest');
  readonly autoZoomY = signal<boolean>(true);

  // Chart viewport (fixed size to avoid layout jumps)
  readonly width = 760;
  readonly height = 240;
  readonly padding = { top: 10, right: 16, bottom: 28, left: 36 };
  @ViewChild('chartCanvas') private canvasRef!: ElementRef<HTMLCanvasElement>;
  private chart: Chart | null = null;

  // Latest buffer (rolling window)
  protected readonly liveRangeMin = signal<number>(this.DEFAULT_LIVE_RANGE_MIN);
  readonly livePoints = signal<Point[]>([]);
  private liveEff?: ReturnType<typeof effect>;

  // History dataset
  private readonly historyRangeH = signal<number>(this.DEFAULT_HISTORY_RANGE_H);
  readonly fromInput = signal<string>(''); // yyyy-MM-ddTHH:mm (local)
  readonly toInput = signal<string>('');
  readonly historyPoints = signal<Point[] | null>(null); // null=not loaded; []=loaded empty
  readonly isLoadingHistory = signal<boolean>(false);
  readonly historyError = signal<string | null>(null);

  // Threshold
  readonly batteryLowThreshold = computed<number>(() => {
    const raw = this.cfg?.batteryLowThresholdPercent ?? this.DEFAULT_BATTERY_LOW_THRESHOLD;
    return Math.max(5, Math.min(50, Math.round(raw)));
  });

  // Axis domains
  private readonly xDomainLatest = computed<[number, number]>(() => {
    // Anchor window to the timestamp of the last point so the domain slides with data
    const pts = this.livePoints();
    const now = pts.length ? pts[pts.length - 1].t : Date.now();
    const from = now - this.liveRangeMin() * 60_000;
    return [from, now];
  });
  private readonly xDomainHistory = computed<[number, number]>(() => {
    const s = this.fromInput();
    const e = this.toInput();
    const from = s ? new Date(s).getTime() : Date.now() - this.historyRangeH() * 3_600_000;
    const to = e ? new Date(e).getTime() : Date.now();
    return [from, to];
  });

  readonly latestSvg = computed(() => this.buildSvgData(this.livePoints(), this.xDomainLatest()));
  readonly historySvg = computed(() => this.buildSvgData(this.historyPoints() ?? [], this.xDomainHistory()));

  // Estimation (History tab)
  readonly estimationText = computed<string>(() => this.buildEstimation());

  ngOnInit(): void {
    // Initialize defaults for inputs
    const now = Date.now();
    const from = new Date(now - this.historyRangeH() * 3_600_000);
    this.fromInput.set(this.toLocalInput(from));
    this.toInput.set(this.toLocalInput(new Date(now)));

    // React to selection or connection to initialize latest buffer
    effect(() => {
      const mowerId = this.ds.selectedId();
      const connected = this.rt.isConnected();
      if (!mowerId) {
        this.livePoints.set([]);
        return;
      }
      // On selection change or when connection is established, seed live buffer
      void this.seedLiveBuffer(mowerId);
    }, { injector: this.injector });

    // Follow live battery updates and append to buffer
    this.liveEff = effect(() => {
      const b = this.rt.battery();
      const mowerId = this.ds.selectedId();
      if (!b || !mowerId) return;
      this.appendLivePoint({ t: new Date(b.timestamp).getTime(), v: clampPct(b.batteryLevel) });
    }, { injector: this.injector });

    // Auto-load history when entering the tab or when selection changes
    effect(() => {
      const tab = this.activeTab();
      const mowerId = this.ds.selectedId();
      if (tab === 'history' && mowerId) {
        void this.reloadHistory();
      }
    }, { injector: this.injector });
  }

  ngAfterViewInit(): void {
    // Create chart once the canvas is available
    this.initChart();
    // Keep chart synchronized with any state change
    effect(() => {
      void this.activeTab();
      void this.livePoints();
      void this.historyPoints();
      void this.autoZoomY();
      void this.fromInput();
      void this.toInput();
      void this.batteryLowThreshold();
      // If canvas element changed due to tab swap, recreate chart on the new element
      if (this.chart && this.chart.canvas !== this.canvasRef?.nativeElement) {
        this.chart.destroy();
        this.initChart();
      }
      this.updateChart();
    }, { injector: this.injector });
  }

  ngOnDestroy(): void {
    this.liveEff?.destroy();
    this.chart?.destroy();
  }

  // --- Commands ---
  async reloadHistory(): Promise<void> {
    const mowerId = this.ds.selectedId();
    if (!mowerId) return;
    const fromIso = this.fromInput() ? new Date(this.fromInput()).toISOString() : new Date(Date.now() - this.historyRangeH() * 3_600_000).toISOString();
    const toIso = this.toInput() ? new Date(this.toInput()).toISOString() : new Date().toISOString();
    this.isLoadingHistory.set(true);
    this.historyError.set(null);
    try {
      const list = await getBatteryHistory(mowerId, fromIso, toIso);
      const pts = list.map(m => ({ t: new Date(m.timestamp).getTime(), v: clampPct(m.batteryLevel) }))
        .sort((a, b) => a.t - b.t);
      this.historyPoints.set(pts);
      if (pts.length === 0) this.historyError.set('404'); // placeholder as 404-equivalent
    } catch (e: any) {
      // For 404, show placeholder text; for others, surface message
      if (e?.status === 404) {
        this.historyPoints.set([]);
        this.historyError.set('404');
      } else {
        this.historyPoints.set([]);
        this.historyError.set(String(e?.message || 'Errore caricamento'));
      }
    } finally {
      this.isLoadingHistory.set(false);
    }
  }

  // --- Helpers ---
  private async seedLiveBuffer(mowerId: number): Promise<void> {
    const toIso = new Date().toISOString();
    const fromIso = new Date(Date.now() - this.liveRangeMin() * 60_000).toISOString();
    try {
      const list = await getBatteryHistory(mowerId, fromIso, toIso);
      const pts = list.map(m => ({ t: new Date(m.timestamp).getTime(), v: clampPct(m.batteryLevel) }))
        .sort((a, b) => a.t - b.t);
      this.livePoints.set(pts);
    } catch {
      // Keep empty; live updates will fill
      this.livePoints.set([]);
    }
  }

  private appendLivePoint(p: Point): void {
    // Keep a rolling window anchored to the point timestamp (robust against stale timestamps)
    const pts = this.livePoints();
    const last = pts[pts.length - 1];
    if (last && Math.abs(last.t - p.t) < 500) return; // de-dup near-identical timestamps
    const from = p.t - this.liveRangeMin() * 60_000;
    const next = [...pts, p].filter(it => it.t >= from && it.t <= p.t);
    this.livePoints.set(next);
  }

  private toLocalInput(d: Date): string {
    const pad = (n: number) => (n < 10 ? '0' + n : '' + n);
    const yyyy = d.getFullYear();
    const MM = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const mm = pad(d.getMinutes());
    return `${yyyy}-${MM}-${dd}T${hh}:${mm}`;
  }

  private buildSvgData(src: Point[], domain: [number, number]) {
    const [from, to] = domain;
    const points = src.filter(p => p.t >= from && p.t <= to);
    const thinned = thin(points, 1000);
    const innerW = this.width - this.padding.left - this.padding.right;
    const innerH = this.height - this.padding.top - this.padding.bottom;
    const xScale = (t: number) => {
      if (to === from) return this.padding.left;
      return this.padding.left + ((t - from) / (to - from)) * innerW;
    };
    // Compute Y domain (auto zoom when enabled, robust to outliers via percentiles)
    let yMin = 0, yMax = 100;
    if (this.autoZoomY() && thinned.length > 0) {
      const vals = thinned.map(p => clampPct(p.v)).sort((a, b) => a - b);
      const q = (r: number) => {
        const idx = Math.min(vals.length - 1, Math.max(0, Math.round(r * (vals.length - 1))));
        return vals[idx];
      };
      const rawMin = q(0.02); // 2nd percentile
      const rawMax = q(0.98); // 98th percentile
      const span = Math.max(0.001, rawMax - rawMin);
      const pad = Math.max(1.5, span * 0.05);
      yMin = clampPct(Math.floor(rawMin - pad));
      yMax = clampPct(Math.ceil(rawMax + pad));
      // Ensure a minimum vertical span
      const minSpan = 10; // percent points
      if (yMax - yMin < minSpan) {
        const mid = (yMax + yMin) / 2;
        yMin = Math.max(0, Math.floor(mid - minSpan / 2));
        yMax = Math.min(100, Math.ceil(mid + minSpan / 2));
      }
    }
    const yScale = (v: number) => {
      const vv = Math.max(yMin, Math.min(yMax, v));
      const ratio = (vv - yMin) / (yMax - yMin || 1);
      return this.padding.top + innerH - ratio * innerH;
    };
    const poly = thinned.map(p => `${xScale(p.t).toFixed(1)},${yScale(p.v).toFixed(1)}`).join(' ');
    const low = this.batteryLowThreshold();
    const lowVisible = low >= yMin && low <= yMax;
    const lowY = yScale(low);
    // Build simple 3-tick scale (min, mid, max)
    const ticks = [yMin, Math.round((yMin + yMax) / 2), yMax];
    const yTicks = ticks.map(v => ({ v, y: yScale(v), label: `${v}%` }));
    const last = thinned[thinned.length - 1] ?? null;
    const lastX = last ? xScale(last.t) : null;
    const lastY = last ? yScale(last.v) : null;
    return { poly, xScale, yScale, lowY, from, to, count: points.length, yMin, yMax, yTicks, lastX, lastY, hasPoints: thinned.length > 0, lowVisible };
  }

  // ---- Chart.js integration ----
  private initChart(): void {
    if (!this.canvasRef?.nativeElement) return;
    const ctx = this.canvasRef.nativeElement.getContext('2d');
    if (!ctx) return;

    const ds: ChartDataset<'line', {x: number, y: number}[]> = {
      label: 'Battery %',
      data: [],
      borderColor: getComputedStyle(document.documentElement).getPropertyValue('--bs-primary') || '#7F8F3D',
      borderWidth: 2,
      pointRadius: 0,
      fill: false,
      spanGaps: true,
    } as any;

    const thresholdPlugin: Plugin<'line'> = {
      id: 'thresholdLine',
      afterDatasetsDraw: (chart) => {
        const yScale = chart.scales['y'];
        const xScale = chart.scales['x'];
        if (!yScale || !xScale) return;
        const low = this.batteryLowThreshold();
        const y = yScale.getPixelForValue(low);
        if (y < chart.chartArea.top || y > chart.chartArea.bottom) return;
        const { ctx } = chart;
        ctx.save();
        ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--bs-danger') || '#F43333';
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.moveTo(chart.chartArea.left, y);
        ctx.lineTo(chart.chartArea.right, y);
        ctx.stroke();
        ctx.restore();
      }
    };

    this.chart = new Chart(ctx, {
      type: 'line',
      data: { datasets: [ds] },
      options: {
        responsive: false,
        animation: false,
        parsing: false,
        normalized: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          decimation: { enabled: true, algorithm: 'lttb', samples: 600 },
          tooltip: { enabled: true, intersect: false, mode: 'nearest', callbacks: { label: (ctx) => `${Math.round((ctx.parsed.y ?? 0) as number)}%` }},
        },
        scales: {
          x: {
            type: 'linear',
            ticks: { callback: (v) => formatTime(Number(v)), maxRotation: 0, autoSkip: true },
            grid: { color: '#adb5bd' as any },
          },
          y: {
            beginAtZero: false,
            ticks: { callback: (v) => `${v}%` },
            grid: { color: '#adb5bd' as any },
          }
        }
      },
      plugins: [thresholdPlugin]
    });
  }

  private updateChart(): void {
    if (!this.chart) return;
    const src = this.activeTab() === 'latest' ? this.livePoints() : (this.historyPoints() ?? []);
    const [from, to] = (this.activeTab() === 'latest') ? this.xDomainLatest() : this.xDomainHistory();
    const filtered = src.filter(p => p.t >= from && p.t <= to);
    const data = filtered.map(p => ({ x: p.t, y: p.v }));

    // Y domain
    let yMin = 0, yMax = 100;
    if (this.autoZoomY() && data.length > 0) {
      const vals = data.map(p => p.y).sort((a, b) => a - b);
      const q = (r: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(r * (vals.length - 1))))];
      const rawMin = q(0.02);
      const rawMax = q(0.98);
      const span = Math.max(0.001, rawMax - rawMin);
      const pad = Math.max(1.5, span * 0.05);
      yMin = Math.max(0, Math.floor(rawMin - pad));
      yMax = Math.min(100, Math.ceil(rawMax + pad));
      if (yMax - yMin < 10) { const mid = (yMax + yMin) / 2; yMin = Math.max(0, Math.floor(mid - 5)); yMax = Math.min(100, Math.ceil(mid + 5)); }
    }

    const ds = this.chart.data.datasets[0] as ChartDataset<'line', {x: number, y: number}[]>;
    ds.data = data;
    (ds as any).pointRadius = data.length <= 1 ? 2.5 : 0;
    (this.chart.options.scales!['x'] as any).min = from;
    (this.chart.options.scales!['x'] as any).max = to;
    (this.chart.options.scales!['y'] as any).min = yMin;
    (this.chart.options.scales!['y'] as any).max = yMax;
    this.chart.update('none');
  }

  private buildEstimation(): string {
    const pts = this.historyPoints();
    if (!pts || pts.length < 3) return 'n/a';
    // Use last N points for slope
    const N = Math.min(5, pts.length);
    const tail = pts.slice(-N);
    const tFirst = tail[0].t;
    const tLast = tail[tail.length - 1].t;
    const vFirst = tail[0].v;
    const vLast = tail[tail.length - 1].v;
    const dtMin = (tLast - tFirst) / 60000;
    if (dtMin <= 0.01) return 'n/a';
    const slopePerMin = (vLast - vFirst) / dtMin; // percent points per minute

    const state = this.rt.state()?.state ?? null;
    const curLevel = this.rt.battery()?.batteryLevel ?? vLast;
    if (state === LawnmowerState.Mowing && slopePerMin < -0.001) {
      const mins = curLevel > 0 ? Math.max(0, Math.round(curLevel / (-slopePerMin))) : 0;
      return `≈ ${mins} min to 0%`;
    }
    if (state === LawnmowerState.StationCharging && slopePerMin > 0.001) {
      const mins = curLevel < 100 ? Math.max(0, Math.round((100 - curLevel) / slopePerMin)) : 0;
      return `≈ ${mins} min to 100%`;
    }
    return 'n/a';
  }
}

function clampPct(v: number): number { return Math.max(0, Math.min(100, v)); }

function thin(points: Point[], max: number): Point[] {
  if (points.length <= max) return points;
  const step = Math.ceil(points.length / max);
  const out: Point[] = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  // HH:mm when same day, otherwise locale short date+time
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
