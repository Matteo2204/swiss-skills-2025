import {ChangeDetectionStrategy, Component, ElementRef, ViewChild, inject, signal} from '@angular/core';
import type {LawnmowerResponse} from '../../../../shared/api/lawnmower-api';
import {NotFoundError, deleteLawnmower} from '../../../../shared/api/lawnmower-api';
import {CommonModule} from '@angular/common';
import {ToastService} from '../../core/toastService';

@Component({
  selector: 'app-delete-mower-dialog',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './delete-mower-dialog.component.html',
  styleUrl: './delete-mower-dialog.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeleteMowerDialogComponent {
  private readonly toast = inject(ToastService);

  @ViewChild('dlg', { static: true }) dlg!: ElementRef<HTMLDialogElement>;

  readonly busy = signal<boolean>(false);
  readonly error = signal<string | null>(null);
  private _mower: LawnmowerResponse | null = null;
  private _resolver: ((value: boolean) => void) | null = null;

  open(mower: LawnmowerResponse): Promise<boolean> {
    this._mower = mower;
    this.busy.set(false);
    this.error.set(null);
    this.dlg.nativeElement.showModal();
    return new Promise<boolean>(resolve => { this._resolver = resolve; });
  }

  onCancel(): void {
    if (this.busy()) return;
    this.dlg.nativeElement.close();
    this._resolver?.(false);
    this._resolver = null;
  }

  async onConfirm(): Promise<void> {
    if (!this._mower || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await deleteLawnmower(this._mower.id);
      this.toast.success('Dispositivo eliminato');
      this.dlg.nativeElement.close();
      this._resolver?.(true);
      this._resolver = null;
    } catch (e: any) {
      if (e instanceof NotFoundError) this.error.set('Dispositivo non trovato.');
      else this.error.set(e?.message ?? 'Eliminazione non riuscita.');
    } finally {
      this.busy.set(false);
    }
  }

  mower(): LawnmowerResponse | null { return this._mower; }
}

