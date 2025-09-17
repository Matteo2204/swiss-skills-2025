import {ChangeDetectionStrategy, Component, OnDestroy, OnInit, Injector, computed, effect, inject, signal} from '@angular/core';
import {CommonModule} from '@angular/common';
import {DeviceSelectionService} from '@shared/services/device-selection.service';
import {RealtimeService} from '@shared/services/realtime.service';
import {AvatarCacheService} from '@shared/services/avatar-cache.service';
import {getGpsCurrent, getGpsHistory, LawnmowerState, type GpsResponse} from '../../../../shared/api/lawnmower-api';

type TabId = 'latest' | 'history';

interface GpsPt { t: number; lat: number; lon: number; }
interface ScaledPt { x: number; y: number; src: GpsPt; }

@Component({
  selector: 'app-gps-map',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'd-block position-relative' },
  templateUrl: './gps-map.component.html',
  styleUrl: './gps-map.component.css',
})
export class GpsMapComponent implements OnInit, OnDestroy {
  readonly ds = inject(DeviceSelectionService);
  readonly rt = inject(RealtimeService);
  private readonly avatars = inject(AvatarCacheService);
  private readonly injector = inject(Injector);

  // Defaults (from CONTEXT.md). Assunzione: LiveRangeSeconds=60s per mappa live.
  private readonly DEFAULT_LIVE_RANGE_SEC = 60; // mostra ~ultimo minuto in live
  private readonly DEFAULT_STUCK_THRESHOLD_MIN = 5;
  private readonly STUCK_DISTANCE_THRESHOLD_M = 3; // somma spostamento < 3 m ⇒ stuck

  // UI tabs
  readonly activeTab = signal<TabId>('latest');

  // ViewBox size (responsive via width:100%)
  readonly vbWidth = 800;
  readonly vbHeight = 480;
  readonly padding = { top: 12, right: 12, bottom: 12, left: 12 };

  // Live window points (retention in seconds)
  readonly liveRangeSec = signal<number>(this.DEFAULT_LIVE_RANGE_SEC);
  readonly livePoints = signal<GpsPt[]>([]);
  private liveEff?: ReturnType<typeof effect>;
  private pollTimer: any = null;
  private liveSeedInFlight = false;
  private lastLiveSeedTs = 0;

  // History points
  readonly fromInput = signal<string>(''); // datetime-local
  readonly toInput = signal<string>('');
  readonly historyPoints = signal<GpsPt[] | null>(null);
  readonly isLoadingHistory = signal<boolean>(false);
  readonly historyError = signal<string | null>(null); // '404' placeholder or error message

  // Hover tooltip state (svg-pixel coords)
  readonly hover = signal<{ x: number; y: number; p: GpsPt } | null>(null);

  // Avatar (data URL) for selected mower
  readonly avatarUrl = computed<string | null | undefined>(() => {
    const id = this.ds.selectedId();
    if (!id) return null;
    return this.avatars.peek(id);
  });

  // Derived SVG data
  readonly latestFallback = computed<GpsPt | null>(() => {
    const g = this.rt.gps();
    return g ? toPt(g) : null;
  });
  readonly latestSvg = computed(() => this.buildSvgData(this.livePoints(), this.latestFallback()));
  readonly historySvg = computed(() => this.buildSvgData(this.historyPoints() ?? []));

  // STUCK detection (live only)
  readonly isStuck = computed<boolean>(() => {
    const state = this.rt.state()?.state ?? null;
    if (state !== LawnmowerState.Mowing) return false;
    const now = Date.now();
    const fromTs = now - this.DEFAULT_STUCK_THRESHOLD_MIN * 60_000;
    const pts = this.livePoints().filter(p => p.t >= fromTs && p.t <= now);
    if (pts.length < 2) return false;
    let dist = 0;
    for (let i = 1; i < pts.length; i++) dist += haversineM(pts[i - 1], pts[i]);
    return dist < this.STUCK_DISTANCE_THRESHOLD_M;
  });

  ngOnInit(): void {
    // Initialize history inputs
    const now = new Date();
    const from = new Date(Date.now() - 24 * 3_600_000); // 24h default history window
    this.fromInput.set(toLocalInput(from));
    this.toInput.set(toLocalInput(now));

    // Reset live buffer when selection changes (niente seed storico: movimento 1Hz)
    effect(() => {
      const mowerId = this.ds.selectedId();
      if (!mowerId) {
        this.livePoints.set([]);
        return;
      }
      // Warm avatar for selected mower (non-bloccante)
      void this.avatars.getUrl(mowerId);
      this.livePoints.set([]);
    }, { injector: this.injector });

    // Append live gps updates
    this.liveEff = effect(() => {
      const g = this.rt.gps();
      const mowerId = this.ds.selectedId();
      if (!g || !mowerId) return;
      const p = toPt(g);
      this.appendLivePoint(p);
    }, { injector: this.injector });

    // 1 Hz sampler: se non arrivano update via hub entro ~1s, interroga /gps/current
    this.pollTimer = setInterval(async () => {
      const mowerId = this.ds.selectedId();
      if (!mowerId) return;
      const lastT = this.livePoints().at(-1)?.t ?? (this.rt.gps() ? new Date(this.rt.gps()!.timestamp).getTime() : 0);
      if (Date.now() - lastT < 900) return; // aggiornato di recente
      try {
        const cur = await getGpsCurrent(mowerId);
        this.appendLivePoint(toPt(cur));
      } catch { /* ignore */ }
    }, 1000);
  }

  ngOnDestroy(): void { this.liveEff?.destroy(); if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; } }

  // Commands
  async reloadHistory(): Promise<void> {
    const mowerId = this.ds.selectedId();
    if (!mowerId) return;
    const fromIso = this.fromInput() ? new Date(this.fromInput()).toISOString() : new Date(Date.now() - 24 * 3_600_000).toISOString();
    const toIso = this.toInput() ? new Date(this.toInput()).toISOString() : new Date().toISOString();
    this.isLoadingHistory.set(true);
    this.historyError.set(null);
    try {
      const rows = await getGpsHistory(mowerId, fromIso, toIso);
      const pts = rows.map(toPt).sort((a, b) => a.t - b.t);
      this.historyPoints.set(pts);
      if (pts.length === 0) this.historyError.set('404');
    } catch (e: any) {
      if (e?.status === 404) {
        this.historyPoints.set([]);
        this.historyError.set('404');
      } else {
        this.historyPoints.set([]);
        this.historyError.set(String(e?.message || 'Errore caricamento'));
      }
    } finally { this.isLoadingHistory.set(false); }
  }

  // Mouse interactions for tooltip (svg pixel coordinates)
  onSvgMove(evt: MouseEvent, kind: 'latest' | 'history'): void {
    const el = evt.currentTarget as SVGSVGElement | null;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = evt.clientX - rect.left;
    const y = evt.clientY - rect.top;
    const data = kind === 'latest' ? this.latestSvg() : this.historySvg();
    if (data.scaled.length === 0) { this.hover.set(null); return; }
    // Find nearest within a small radius
    let best: ScaledPt | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (const sp of data.scaled) {
      const dx = sp.x - x, dy = sp.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD) { bestD = d2; best = sp; }
    }
    // 20px radius threshold
    if (best && bestD <= 20 * 20) this.hover.set({ x: best.x, y: best.y, p: best.src });
    else this.hover.set(null);
  }
  onSvgLeave(): void { this.hover.set(null); }

  // Helpers
  private async seedLiveBuffer(mowerId: number): Promise<void> {
    if (this.liveSeedInFlight) return;
    this.liveSeedInFlight = true;
    const toIso = new Date().toISOString();
    const fromIso = new Date(Date.now() - Math.max(this.liveRangeSec(), this.DEFAULT_STUCK_THRESHOLD_MIN * 60) * 1000).toISOString();
    try {
      const rows = await getGpsHistory(mowerId, fromIso, toIso);
      const pts = rows.map(toPt).sort((a, b) => a.t - b.t);
      this.livePoints.set(pts);
      this.lastLiveSeedTs = Date.now();
    } catch {
      this.livePoints.set([]);
      this.lastLiveSeedTs = Date.now();
    } finally {
      this.liveSeedInFlight = false;
    }
  }

  private appendLivePoint(p: GpsPt): void {
    const retentionSec = Math.max(this.liveRangeSec(), this.DEFAULT_STUCK_THRESHOLD_MIN * 60);
    const ms = retentionSec * 1000;
    const from = Date.now() - ms;
    const pts = this.livePoints();
    const last = pts[pts.length - 1];
    if (last && approxSameSample(last, p)) return; // de-dup quasi-identici
    const next = [...pts, p].filter(it => it.t >= from);
    this.livePoints.set(next);
  }

  private buildSvgData(src: GpsPt[], fallback?: GpsPt | null) {
    const pts = thin(src.length ? src : (fallback ? [fallback] : []), 1200);
    const innerW = this.vbWidth - this.padding.left - this.padding.right;
    const innerH = this.vbHeight - this.padding.top - this.padding.bottom;
    if (pts.length === 0) {
      return { poly: '', scaled: [] as ScaledPt[], marker: null as ScaledPt | null, box: null as null };
    }
    let minLat = pts[0].lat, maxLat = pts[0].lat;
    let minLon = pts[0].lon, maxLon = pts[0].lon;
    for (const p of pts) {
      if (p.lat < minLat) minLat = p.lat; if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon; if (p.lon > maxLon) maxLon = p.lon;
    }
    // Expand by small epsilon to avoid zero extent
    const eps = 1e-6;
    if (maxLat - minLat < eps) { maxLat = minLat + eps; }
    if (maxLon - minLon < eps) { maxLon = minLon + eps; }
    // Add 5% margin visually
    const latPad = (maxLat - minLat) * 0.05; minLat -= latPad; maxLat += latPad;
    const lonPad = (maxLon - minLon) * 0.05; minLon -= lonPad; maxLon += lonPad;

    const xScale = (lon: number) => this.padding.left + ((lon - minLon) / (maxLon - minLon)) * innerW;
    // SVG y grows downward; higher latitude → lower y
    const yScale = (lat: number) => this.padding.top + (1 - (lat - minLat) / (maxLat - minLat)) * innerH;

    const scaled: ScaledPt[] = pts.map(p => ({ x: xScale(p.lon), y: yScale(p.lat), src: p }));
    const poly = scaled.map(s => `${s.x.toFixed(1)},${s.y.toFixed(1)}`).join(' ');
    const last = scaled[scaled.length - 1];
    return { poly, scaled, marker: last, box: { minLat, maxLat, minLon, maxLon } };
  }

  // Format helper (ISO string)
  iso(ts: number): string { return new Date(ts).toISOString(); }
}

// Utilities
function toPt(r: GpsResponse): GpsPt {
  return { t: new Date(r.timestamp).getTime(), lat: r.latitude, lon: r.longitude };
}

function approxSameSample(a: GpsPt, b: GpsPt): boolean {
  const dt = Math.abs(a.t - b.t);
  const d = haversineM(a, b);
  return dt < 500 && d < 0.1; // 10 cm threshold if timestamps virtually equal
}

function toLocalInput(d: Date): string {
  const pad = (n: number) => (n < 10 ? '0' + n : '' + n);
  const yyyy = d.getFullYear();
  const MM = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  return `${yyyy}-${MM}-${dd}T${hh}:${mm}`;
}

function thin(points: GpsPt[], max: number): GpsPt[] {
  if (points.length <= max) return points;
  const step = Math.ceil(points.length / max);
  const out: GpsPt[] = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

// Haversine distance in meters (simplified)
function haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000; // earth radius m
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
