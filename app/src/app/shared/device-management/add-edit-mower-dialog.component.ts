import {ChangeDetectionStrategy, Component, ElementRef, ViewChild, inject, signal, OnInit, OnDestroy} from '@angular/core';
import {CommonModule} from '@angular/common';
import {ReactiveFormsModule, FormBuilder, Validators, FormGroup} from '@angular/forms';
import {Subscription} from 'rxjs';
import type {LawnmowerResponse} from '../../../../shared/api/lawnmower-api';
import {BadRequestError, NotFoundError, createLawnmower, deleteAvatar, updateLawnmower, uploadAvatar} from '../../../../shared/api/lawnmower-api';
import {ToastService} from '../../core/toastService';
import {AvatarCacheService} from '../services/avatar-cache.service';

type Mode = 'create' | 'edit';

@Component({
  selector: 'app-add-edit-mower-dialog',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './add-edit-mower-dialog.component.html',
  styleUrl: './add-edit-mower-dialog.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AddEditMowerDialogComponent implements OnInit, OnDestroy {
  private readonly fb = inject(FormBuilder);
  private readonly toast = inject(ToastService);
  private readonly avatars = inject(AvatarCacheService);

  @ViewChild('dlg', { static: true }) dlg!: ElementRef<HTMLDialogElement>;
  @ViewChild('nameInput') nameInput!: ElementRef<HTMLInputElement>;

  readonly mode = signal<Mode>('create');
  readonly busy = signal<boolean>(false);
  readonly error = signal<string | null>(null);
  readonly hasChanges = signal<boolean>(false);

  private _existing: LawnmowerResponse | null = null;
  private _resolver: ((value: LawnmowerResponse | null) => void) | null = null;
  private formSub: Subscription | null = null;

  // Avatar state
  readonly currentAvatarUrl = signal<string | null | undefined>(undefined); // undefined=loading, null=none
  private selectedFile: File | null = null;
  // Exposed for template logic in disabled state
  selectedFileDataUrl: string | null = null;
  private removeAvatar = false;

  readonly form: FormGroup = this.fb.group({
    name: ['', [Validators.required, Validators.maxLength(100)]],
    address: ['', [Validators.required, Validators.pattern(/^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d):([1-9]\d{0,4})$/)]],
  });

  ngOnInit(): void {
    // Recompute hasChanges whenever the form values change.
    this.formSub = this.form.valueChanges.subscribe(() => this.updateHasChanges());
  }

  ngOnDestroy(): void {
    this.formSub?.unsubscribe();
    this.formSub = null;
  }

  openForCreate(): Promise<LawnmowerResponse | null> {
    this.mode.set('create');
    this._existing = null;
    this.form.reset({ name: '', address: '' });
    this.form.get('address')!.enable({ emitEvent: false });
    this.error.set(null);
    this.busy.set(false);
    this.setAvatarInitialForCreate();
    this.updateHasChanges();
    this.dlg.nativeElement.showModal();
    queueMicrotask(() => this.nameInput?.nativeElement?.focus());
    return new Promise<LawnmowerResponse | null>(resolve => { this._resolver = resolve; });
  }

  async openForEdit(mower: LawnmowerResponse): Promise<LawnmowerResponse | null> {
    this.mode.set('edit');
    this._existing = mower;
    this.form.reset({ name: mower.name, address: mower.address });
    this.form.get('address')!.disable({ emitEvent: false });
    this.error.set(null);
    this.busy.set(false);
    this.removeAvatar = false;
    this.selectedFile = null;
    this.selectedFileDataUrl = null;
    // Load current avatar for preview
    this.currentAvatarUrl.set(undefined);
    try {
      const url = await this.avatars.getUrl(mower.id);
      this.currentAvatarUrl.set(url);
    } catch {
      this.currentAvatarUrl.set(null);
    }
    this.updateHasChanges();
    this.dlg.nativeElement.showModal();
    queueMicrotask(() => this.nameInput?.nativeElement?.focus());
    return new Promise<LawnmowerResponse | null>(resolve => { this._resolver = resolve; });
  }

  onClose(): void {
    if (this.busy()) return; // prevent closing while busy
    this.dlg.nativeElement.close();
    this._resolver?.(null);
    this._resolver = null;
  }

  async onSubmit(): Promise<void> {
    if (this.busy()) return;
    this.error.set(null);
    if (this.form.invalid) {
      this.error.set('Compila i campi obbligatori.');
      return;
    }
    this.busy.set(true);
    try {
      const name = this.form.get('name')!.value?.trim();
      const address = (this._existing?.address ?? this.form.get('address')!.value)?.trim();
      if (!name || !address) {
        this.error.set('Compila i campi obbligatori.');
        return;
      }
      if (this.mode() === 'create') {
        const created = await createLawnmower({ name, address });
        // Upload avatar if selected
        if (this.selectedFile) {
          await uploadAvatar(created.id, this.selectedFile);
          if (this.selectedFileDataUrl) this.avatars.setDataUrl(created.id, this.selectedFileDataUrl);
        }
        this.toast.success('Dispositivo creato');
        this.dlg.nativeElement.close();
        this._resolver?.(created);
        this._resolver = null;
      } else if (this._existing) {
        const updated = await updateLawnmower(this._existing.id, { name, address });
        // Avatar changes
        if (this.selectedFile) {
          await uploadAvatar(updated.id, this.selectedFile);
          if (this.selectedFileDataUrl) this.avatars.setDataUrl(updated.id, this.selectedFileDataUrl);
        } else if (this.removeAvatar) {
          await deleteAvatar(updated.id);
          this.avatars.setDataUrl(updated.id, null);
        }
        this.toast.success('Modifiche salvate');
        this.dlg.nativeElement.close();
        this._resolver?.(updated);
        this._resolver = null;
      }
    } catch (e: any) {
      this.error.set(this.mapError(e));
    } finally {
      this.busy.set(false);
      this.updateHasChanges();
    }
  }

  // Avatar handlers
  async onFileSelected(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files && input.files[0] ? input.files[0] : null;
    if (!file) { this.clearSelectedFile(); return; }
    if (!['image/png', 'image/jpeg', 'image/bmp'].includes(file.type)) {
      this.error.set('Formato non valido. Usa PNG, JPEG o BMP.');
      input.value = '';
      return;
    }
    this.selectedFile = file;
    this.removeAvatar = false;
    this.selectedFileDataUrl = await this.fileToDataURL(file);
    this.updateHasChanges();
  }

  onRemoveAvatar(): void {
    if (this.mode() === 'create') {
      this.clearSelectedFile();
    } else {
      // Mark for deletion
      this.removeAvatar = true;
      this.selectedFile = null;
      this.selectedFileDataUrl = null;
      this.updateHasChanges();
    }
  }

  previewUrl(): string | null | undefined {
    // Priority: selected file -> (edit) current avatar -> null
    if (this.selectedFileDataUrl !== null) return this.selectedFileDataUrl;
    return this.currentAvatarUrl();
  }

  // Helpers
  private updateHasChanges(): void {
    if (this.mode() === 'create') {
      this.hasChanges.set(this.form.valid && (!!this.form.get('name')!.value || !!this.form.get('address')!.value || !!this.selectedFile));
      return;
    }
    // edit: name change OR avatar change
    const nameChanged = this._existing ? (this.form.get('name')!.value ?? '') !== this._existing.name : false;
    const avatarChanged = !!this.selectedFile || this.removeAvatar === true;
    this.hasChanges.set(nameChanged || avatarChanged);
  }

  private setAvatarInitialForCreate(): void {
    this.currentAvatarUrl.set(null);
    this.selectedFile = null;
    this.selectedFileDataUrl = null;
    this.removeAvatar = false;
  }

  private clearSelectedFile(): void {
    this.selectedFile = null;
    this.selectedFileDataUrl = null;
  }

  private async fileToDataURL(file: File): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  private mapError(e: any): string {
    if (e instanceof NotFoundError) return 'Dispositivo non trovato.';
    if (e instanceof BadRequestError) {
      const m = (e.message || '').toLowerCase();
      if (m.includes('name') && (m.includes('unique') || m.includes('duplicate'))) return 'Nome già in uso.';
      if (m.includes('address') && (m.includes('unique') || m.includes('duplicate'))) return 'Indirizzo già in uso.';
      return 'Dati non validi.';
    }
    return e?.message ?? 'Operazione non riuscita.';
  }
}
