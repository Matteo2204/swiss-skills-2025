import {ChangeDetectionStrategy, Component, ElementRef, ViewChild, computed, inject, signal} from '@angular/core';
import {CommonModule} from '@angular/common';
import {DeviceSelectionService} from '../services/device-selection.service';
import {ToastService} from '../../core/toastService';
import {
  LawnmowerState,
  importBattery,
  importGps,
  importState,
  type BatteryImportRequest,
  type GpsImportRequest,
  type StateImportRequest,
} from '../../../../shared/api/lawnmower-api';

interface ImportSummary {
  battery?: { valid: number; invalid: number; error?: string };
  gps?: { valid: number; invalid: number; error?: string };
  state?: { valid: number; invalid: number; error?: string };
}

@Component({
  selector: 'app-import-dialog',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './import-dialog.component.html',
  styleUrl: './import-dialog.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ImportDialogComponent {
  private readonly ds = inject(DeviceSelectionService);
  private readonly toast = inject(ToastService);

  @ViewChild('dlg', { static: true }) dlg!: ElementRef<HTMLDialogElement>;
  @ViewChild('fileInput') fileInput!: ElementRef<HTMLInputElement>;

  readonly busy = signal<boolean>(false);
  readonly error = signal<string | null>(null);
  readonly fileName = signal<string | null>(null);
  readonly summary = signal<ImportSummary | null>(null);

  readonly canImport = computed<boolean>(() => !!this.fileName() && !!this.ds.selectedId());

  open(): Promise<void> {
    this.reset();
    this.dlg.nativeElement.showModal();
    return Promise.resolve();
  }

  onClose(): void {
    if (this.busy()) return;
    this.dlg.nativeElement.close();
  }

  onFileChosen(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files && input.files[0] ? input.files[0] : null;
    if (!file) {
      this.fileName.set(null);
      return;
    }
    this.fileName.set(file.name);
  }

  async onImport(): Promise<void> {
    if (this.busy()) return;
    this.error.set(null);
    this.summary.set(null);
    const id = this.ds.selectedId();
    if (!id) { this.error.set('Seleziona un dispositivo prima di importare.'); return; }
    const inputEl = this.fileInput?.nativeElement;
    const file = inputEl?.files && inputEl.files[0] ? inputEl.files[0] : null;
    if (!file) { this.error.set('Seleziona un file JSON.'); return; }

    this.busy.set(true);
    try {
      const text = await file.text();
      let json: any;
      try { json = JSON.parse(text); }
      catch { this.error.set('File JSON non valido.'); return; }

      const { battery, gps, state } = this.extractSections(json);
      if (!battery && !gps && !state) {
        this.error.set('Formato non valido: sezioni assenti.');
        return;
      }

      const summary: ImportSummary = {};

      // Battery
      if (battery) {
        const { valid, invalid } = this.validateBattery(battery);
        summary.battery = { valid: valid.measurements.length, invalid };
        if (valid.measurements.length) {
          try { await importBattery(id, valid); }
          catch (e: any) { summary.battery.error = e?.message ?? 'Errore import.'; }
        }
      }

      // GPS
      if (gps) {
        const { valid, invalid } = this.validateGps(gps);
        summary.gps = { valid: valid.measurements.length, invalid };
        if (valid.measurements.length) {
          try { await importGps(id, valid); }
          catch (e: any) { summary.gps.error = e?.message ?? 'Errore import.'; }
        }
      }

      // State
      if (state) {
        const { valid, invalid } = this.validateState(state);
        summary.state = { valid: valid.measurements.length, invalid };
        if (valid.measurements.length) {
          try { await importState(id, valid); }
          catch (e: any) { summary.state.error = e?.message ?? 'Errore import.'; }
        }
      }

      this.summary.set(summary);

      const totalImported = (summary.battery?.valid ?? 0) + (summary.gps?.valid ?? 0) + (summary.state?.valid ?? 0);
      const hadErrors = !!(summary.battery?.error || summary.gps?.error || summary.state?.error);
      if (totalImported > 0 && !hadErrors) {
        this.toast.success('Import completato');
      } else if (totalImported > 0 && hadErrors) {
        this.toast.warning('Import parziale completato con errori');
      } else {
        this.toast.error('Nessun dato importato');
      }
    } catch (e: any) {
      this.error.set(e?.message ?? 'Import non riuscito.');
    } finally {
      this.busy.set(false);
    }
  }

  private reset(): void {
    this.busy.set(false);
    this.error.set(null);
    this.fileName.set(null);
    this.summary.set(null);
    if (this.fileInput?.nativeElement) this.fileInput.nativeElement.value = '';
  }

  private extractSections(json: any): { battery?: any; gps?: any; state?: any } {
    const battery = json && typeof json === 'object' && json.battery && typeof json.battery === 'object' ? json.battery : undefined;
    const gps = json && typeof json === 'object' && json.gps && typeof json.gps === 'object' ? json.gps : undefined;
    const state = json && typeof json === 'object' && json.state && typeof json.state === 'object' ? json.state : undefined;
    return { battery, gps, state };
  }

  private validateBattery(section: any): { valid: BatteryImportRequest; invalid: number } {
    const arr = Array.isArray(section.measurements) ? section.measurements : [];
    const out: BatteryImportRequest = { measurements: [] };
    let invalid = 0;
    for (const m of arr) {
      const ts = this.toIso(m?.timestamp);
      const lvl = typeof m?.batteryLevel === 'number' && Number.isFinite(m.batteryLevel) ? m.batteryLevel : null;
      if (ts && lvl !== null) out.measurements.push({ timestamp: ts, batteryLevel: lvl });
      else invalid++;
    }
    return { valid: out, invalid };
  }

  private validateGps(section: any): { valid: GpsImportRequest; invalid: number } {
    const arr = Array.isArray(section.measurements) ? section.measurements : [];
    const out: GpsImportRequest = { measurements: [] };
    let invalid = 0;
    for (const m of arr) {
      const ts = this.toIso(m?.timestamp);
      const latOk = typeof m?.latitude === 'number' && Number.isFinite(m.latitude);
      const lonOk = typeof m?.longitude === 'number' && Number.isFinite(m.longitude);
      if (ts && latOk && lonOk) out.measurements.push({ timestamp: ts, latitude: m.latitude, longitude: m.longitude });
      else invalid++;
    }
    return { valid: out, invalid };
  }

  private validateState(section: any): { valid: StateImportRequest; invalid: number } {
    const arr = Array.isArray(section.measurements) ? section.measurements : [];
    const out: StateImportRequest = { measurements: [] };
    let invalid = 0;
    for (const m of arr) {
      const ts = this.toIso(m?.timestamp);
      const st = typeof m?.state === 'number' && Number.isInteger(m.state) ? m.state as number : null;
      const inRange = st !== null && st >= 0 && st <= (LawnmowerState.Error as number);
      if (ts && inRange) out.measurements.push({ timestamp: ts, state: st as LawnmowerState });
      else invalid++;
    }
    return { valid: out, invalid };
  }

  private toIso(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    try {
      const d = new Date(value as any);
      if (isNaN(d.getTime())) return null;
      return d.toISOString();
    } catch {
      return null;
    }
  }
}

