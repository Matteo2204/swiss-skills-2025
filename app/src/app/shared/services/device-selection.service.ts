import {Injectable, computed, signal} from '@angular/core';
import type {LawnmowerResponse} from '../../../../shared/api/lawnmower-api';

// Global selection signal for the current mower used by cockpit and others.
@Injectable({ providedIn: 'root' })
export class DeviceSelectionService {
  private static readonly LS_KEY = 'device.selectedId';

  readonly selected = signal<LawnmowerResponse | null>(null);
  readonly selectedId = computed<number | null>(() => this.selected()?.id ?? null);
  readonly hasSelection = computed<boolean>(() => this.selected() !== null);

  setSelected(mower: LawnmowerResponse | null): void {
    this.selected.set(mower);
    try {
      if (mower) localStorage.setItem(DeviceSelectionService.LS_KEY, String(mower.id));
      else localStorage.removeItem(DeviceSelectionService.LS_KEY);
    } catch { /* ignore storage errors (e.g., SSR) */ }
  }

  // Initialize selection from stored id if present in the provided list.
  initFromList(list: LawnmowerResponse[]): void {
    let storedId: number | null = null;
    try {
      const raw = localStorage.getItem(DeviceSelectionService.LS_KEY);
      if (raw) storedId = Number(raw);
    } catch { /* ignore */ }
    if (!storedId) return;
    const found = list.find(l => l.id === storedId) ?? null;
    if (found) this.selected.set(found);
    else this.setSelected(null);
  }
}

