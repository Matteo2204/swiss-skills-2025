import {ChangeDetectionStrategy, Component, ElementRef, ViewChild, computed, inject, signal} from '@angular/core';
import {CommonModule} from '@angular/common';
import {DeviceSelectionService} from '../services/device-selection.service';
import {ToastService} from '../../core/toastService';
import {IpcService} from '../../core/ipc.service';
import {
  type BatteryResponse,
  type GpsResponse,
  type StateResponse,
  type LawnmowerResponse,
  getBatteryCurrent,
  getGpsCurrent,
  getStateCurrent,
  getBatteryHistory,
  getGpsHistory,
  getStateHistory,
  getLawnmower,
} from '../../../../shared/api/lawnmower-api';

type Mode = 'current' | 'history';

interface ExportResultPath { ok: true; path: string }
interface ExportResultError { ok: false; error?: string; canceled?: boolean }
type ExportIpcResult = ExportResultPath | ExportResultError;

@Component({
  selector: 'app-export-dialog',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './export-dialog.component.html',
  styleUrl: './export-dialog.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExportDialogComponent {
  private readonly ds = inject(DeviceSelectionService);
  private readonly toast = inject(ToastService);
  private readonly ipc = inject(IpcService);

  @ViewChild('dlg', { static: true }) dlg!: ElementRef<HTMLDialogElement>;

  readonly busy = signal<boolean>(false);
  readonly error = signal<string | null>(null);
  readonly mode = signal<Mode>('current');

  // Defaults per CONTEXT.md: HistoryRange (ore) default=24 (assunzione: loader config non disponibile qui)
  readonly DEFAULT_HISTORY_RANGE_H = 24;
  readonly fromInput = signal<string>(''); // yyyy-MM-ddTHH:mm (local)
  readonly toInput = signal<string>('');

  readonly isCurrent = computed(() => this.mode() === 'current');
  readonly canExport = computed(() => !!this.ds.selectedId() && !this.busy());

  open(): Promise<void> {
    this.reset();
    const now = Date.now();
    const from = new Date(now - this.DEFAULT_HISTORY_RANGE_H * 3_600_000);
    this.fromInput.set(this.toLocalInput(from));
    this.toInput.set(this.toLocalInput(new Date(now)));
    this.dlg.nativeElement.showModal();
    return Promise.resolve();
  }

  onClose(): void {
    if (this.busy()) return;
    this.dlg.nativeElement.close();
  }

  onToggleMode(m: Mode): void {
    if (this.busy()) return;
    this.mode.set(m);
  }

  async onExport(): Promise<void> {
    if (this.busy()) return;
    const id = this.ds.selectedId();
    if (!id) { this.error.set('Seleziona un dispositivo.'); return; }

    this.busy.set(true);
    this.error.set(null);
    try {
      const mower = await getLawnmower(id);
      const payload = this.isCurrent() ? await this.buildCurrentPayload(mower) : await this.buildHistoryPayload(mower);
      const fileName = this.buildFileName(mower.id);
      const content = JSON.stringify(payload, null, 2);

      const saved = await this.saveViaBridge(fileName, content);
      if (saved?.ok) {
        this.toast.success(`Esportato in: ${saved.path}`);
        this.dlg.nativeElement.close();
      } else if (saved?.canceled) {
        // Silent cancel
      } else {
        const err = saved?.error ?? 'Salvataggio non riuscito.';
        this.toast.error(err);
      }
    } catch (e: any) {
      this.error.set(e?.message ?? 'Export non riuscito.');
      this.toast.error(this.error()!);
    } finally {
      this.busy.set(false);
    }
  }

  // --- Builders ---
  private async buildCurrentPayload(mower: LawnmowerResponse): Promise<any> {
    const id = mower.id;
    const result: any = {
      mower: { id: mower.id, name: mower.name, address: mower.address },
      battery: {} as { current?: BatteryResponse | null },
      gps: {} as { current?: GpsResponse | null },
      state: {} as { current?: StateResponse | null },
    };

    // Current endpoints; 404 => null
    const sections: Array<[keyof typeof result, Promise<any>]> = [
      ['battery', getBatteryCurrent(id)],
      ['gps', getGpsCurrent(id)],
      ['state', getStateCurrent(id)],
    ];

    const settled = await Promise.allSettled(sections.map(s => s[1]));
    for (let i = 0; i < settled.length; i++) {
      const key = sections[i][0] as 'battery' | 'gps' | 'state';
      const s = settled[i];
      if (s.status === 'fulfilled') {
        (result[key] as any).current = s.value;
      } else {
        const err: any = s.reason;
        if (err?.status === 404) (result[key] as any).current = null; // per AC
        else throw err; // abort on non-404
      }
    }
    return result;
  }

  private async buildHistoryPayload(mower: LawnmowerResponse): Promise<any> {
    const id = mower.id;
    const fromIso = this.fromInput() ? new Date(this.fromInput()).toISOString() : new Date(Date.now() - this.DEFAULT_HISTORY_RANGE_H * 3_600_000).toISOString();
    const toIso = this.toInput() ? new Date(this.toInput()).toISOString() : new Date().toISOString();
    const result: any = {
      mower: { id: mower.id, name: mower.name, address: mower.address },
      battery: {} as { history?: BatteryResponse[] },
      gps: {} as { history?: GpsResponse[] },
      state: {} as { history?: StateResponse[] },
    };

    const sections: Array<[keyof typeof result, Promise<any>]> = [
      ['battery', getBatteryHistory(id, fromIso, toIso)],
      ['gps', getGpsHistory(id, fromIso, toIso)],
      ['state', getStateHistory(id, fromIso, toIso)],
    ];

    const settled = await Promise.allSettled(sections.map(s => s[1]));
    for (let i = 0; i < settled.length; i++) {
      const key = sections[i][0] as 'battery' | 'gps' | 'state';
      const s = settled[i];
      if (s.status === 'fulfilled') {
        (result[key] as any).history = s.value ?? [];
      } else {
        const err: any = s.reason;
        if (err?.status === 404) (result[key] as any).history = []; // per AC
        else throw err; // abort on non-404
      }
    }
    return result;
  }

  // --- Persistence ---
  private async saveViaBridge(suggestedFileName: string, content: string): Promise<ExportIpcResult | null> {
    try {
      const res = await this.ipc.invoke<ExportIpcResult>('export:save-json', { suggestedFileName, content });
      return res;
    } catch (e: any) {
      // fall through to browser fallback
    }
    // Dev fallback: trigger browser download
    try {
      const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = suggestedFileName; a.style.display = 'none';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      this.toast.info(`Download avviato: ${suggestedFileName}`);
      return { ok: true, path: suggestedFileName } as ExportResultPath;
    } catch (err: any) {
      return { ok: false, error: String(err?.message || 'DOWNLOAD_FAILED') } as ExportResultError;
    }
  }

  // --- Utils ---
  private toLocalInput(d: Date): string {
    const pad = (n: number) => (n < 10 ? '0' + n : '' + n);
    const yyyy = d.getFullYear();
    const MM = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const mm = pad(d.getMinutes());
    return `${yyyy}-${MM}-${dd}T${hh}:${mm}`;
  }

  private buildFileName(id: number): string {
    const d = new Date();
    const pad = (n: number) => (n < 10 ? '0' + n : '' + n);
    const y = d.getFullYear();
    const M = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const h = pad(d.getHours());
    const m = pad(d.getMinutes());
    const s = pad(d.getSeconds());
    return `mower-${id}-${y}${M}${day}-${h}${m}${s}.json`;
  }

  private reset(): void {
    this.busy.set(false);
    this.error.set(null);
    this.mode.set('current');
  }
}
