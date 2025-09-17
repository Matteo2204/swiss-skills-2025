import {Component, inject, signal} from '@angular/core';
import {Item} from '../../../../shared/models';
import {IpcService} from '../../../../core/ipc.service';
import {AuthService} from '../../../../core/auth.service';
import {FormsModule} from '@angular/forms';
import {NgForOf, NgIf} from '@angular/common';
import {ToastService} from '../../../../core/toastService';

@Component({
  selector: 'app-items-component',
  standalone: true,
  imports: [
    FormsModule,
    NgForOf,
    NgIf
  ],
  templateUrl: './items-component.html',
  styleUrl: './items-component.css'
})
export class ItemsComponent {
  toastService = inject(ToastService);
  data = signal<Item[]>([]);
  name = '';
  err = '';
  constructor(private ipc: IpcService, private auth: AuthService) {
    this.auth.ready().then(() => this.load());
  }
  async load() {
    const res: any = await this.ipc.invoke('items:list', this.auth.withToken());
    if (res.ok) this.data.set(res.data);
  }
  async create() {
    this.err = '';
    const res: any = await this.ipc.invoke('items:create', this.auth.withToken({ name: this.name }));
    if (!res.ok) { this.err = 'Nome non valido'; return; }
    this.toastService.success('Elemento creato con successo');
    this.name = '';
    this.load();
  }
  async del(it: Item) {
    await this.ipc.invoke('items:delete', this.auth.withToken({ id: it.id }));
    this.load();
  }
  lol() {
    this.toastService.success('Operazione completata con successo');
  }
}
