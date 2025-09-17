import {ChangeDetectionStrategy, Component, ViewChild, effect, inject, output, signal} from '@angular/core';
import type {LawnmowerResponse} from '../../../../shared/api/lawnmower-api';
import {getLawnmowers} from '../../../../shared/api/lawnmower-api';
import {DeviceSelectionService} from '../services/device-selection.service';
import {AvatarCacheService} from '../services/avatar-cache.service';
import {AddEditMowerDialogComponent} from '../device-management/add-edit-mower-dialog.component';
import {DeleteMowerDialogComponent} from '../device-management/delete-mower-dialog.component';

@Component({
  selector: 'app-device-selector',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'd-inline-block' },
  templateUrl: './device-selector.component.html',
  styleUrl: './device-selector.component.css',
  imports: [AddEditMowerDialogComponent, DeleteMowerDialogComponent],
})
export class DeviceSelectorComponent {
  private readonly selection = inject(DeviceSelectionService);
  private readonly avatars = inject(AvatarCacheService);

  // Outputs
  selectedChange = output<LawnmowerResponse | null>();

  // Local state
  readonly loading = signal<boolean>(true);
  readonly error = signal<string | null>(null);
  readonly mowers = signal<LawnmowerResponse[]>([]);
  private readonly _avatarsVersion = signal<number>(0);

  readonly current = this.selection.selected;

  @ViewChild(AddEditMowerDialogComponent) addEdit!: AddEditMowerDialogComponent;
  @ViewChild(DeleteMowerDialogComponent) delDlg!: DeleteMowerDialogComponent;

  constructor() {
    // Load list on init
    void this.refresh();

    // Warm avatar cache when list updates
    effect(() => {
      const ids = this.mowers().map(m => m.id);
      if (ids.length) void this.avatars.warm(ids).then(() => this._avatarsVersion.update(v => v + 1));
    });
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const list = await getLawnmowers();
      this.mowers.set(list);
      // Try restore previous selection from storage
      this.selection.initFromList(list);
    } catch (e: any) {
      this.error.set(e?.message ?? 'Failed to load devices');
    } finally {
      this.loading.set(false);
    }
  }

  async onSelect(m: LawnmowerResponse): Promise<void> {
    this.selection.setSelected(m);
    this.selectedChange.emit(m);
    // Ensure avatar for selected is cached
    await this.avatars.getUrl(m.id).then(() => this._avatarsVersion.update(v => v + 1));
  }

  onClear(): void {
    this.selection.setSelected(null);
    this.selectedChange.emit(null);
  }

  avatarUrl(id: number): string | null | undefined {
    // Create a dependency so that UI updates when cache warms
    void this._avatarsVersion();
    return this.avatars.peek(id);
  }

  // Dialog actions
  async onAdd(): Promise<void> {
    const res = await this.addEdit.openForCreate();
    if (res) {
      await this.refresh();
      // Select the newly created
      this.selection.setSelected(res);
      this.selectedChange.emit(res);
      // Warm avatar cache for created id
      await this.avatars.getUrl(res.id).then(() => this._avatarsVersion.update(v => v + 1));
    }
  }

  async onEdit(): Promise<void> {
    const cur = this.current();
    if (!cur) return;
    const res = await this.addEdit.openForEdit(cur);
    if (res) {
      // Update selection and refresh list
      this.selection.setSelected(res);
      this.selectedChange.emit(res);
      await this.refresh();
      this._avatarsVersion.update(v => v + 1);
    }
  }

  async onDelete(): Promise<void> {
    const cur = this.current();
    if (!cur) return;
    const ok = await this.delDlg.open(cur);
    if (ok) {
      // If deleted current, clear selection
      if (this.current()?.id === cur.id) {
        this.onClear();
      }
      await this.refresh();
      this._avatarsVersion.update(v => v + 1);
    }
  }
}
