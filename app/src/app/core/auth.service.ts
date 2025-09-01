// app/core/auth.service.ts
import { computed, Injectable, signal, inject } from '@angular/core';
import { LoginResult, Role } from '../shared/models';
import { IpcService } from './ipc.service';
import { environment } from '../../environments/environment';

export interface User {
  id: number;
  role: Role;
  username: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly STORAGE_KEY = 'auth/v1';

  private readonly _token = signal<string | null>(null);
  private readonly _user  = signal<User | null>(null);

  // Derived state
  isLoggedIn = computed(() => this._token() !== null && this._user() !== null);
  role       = computed<Role | null>(() => this._user()?.role ?? null);
  user       = computed<User | null>(() => this._user());

  private readonly ipc = inject(IpcService);

  constructor() {
    // 1) ripristina sessione da localStorage
    this.restore();

    // 2) auto-login solo in dev (se non già loggato)
    if ((environment as any)?.devAutoLogin && !this.isLoggedIn()) {
      this.setSession({ id: 0, username: 'dev-admin', role: Role.ADMIN }, 'DEV');
    }
  }

  // --- API ---
  async login(username: string, password: string): Promise<boolean> {
    const res = await this.ipc.invoke<LoginResult>('auth:login', { username, password });
    if (res?.ok && res.user) {
      // se il backend non fornisce token, usiamo uno stub per la sessione
      const token = res.token ?? 'SESSION';
      this.setSession(res.user as User, token);
      return true;
    }
    return false;
  }

  async logout(): Promise<void> {
    const t = this._token();
    try { if (t) await this.ipc.invoke('auth:logout', t); } catch { /* ignore */ }
    this._token.set(null);
    this._user.set(null);
    localStorage.removeItem(this.STORAGE_KEY);
  }

  withToken<T extends object = Record<string, unknown>>(payload: T = {} as T): T & { token: string | null } {
    return { ...payload, token: this._token() };
  }

  // Opzionale: registrazione
  async register(username: string, password: string): Promise<{ ok: boolean; error?: string }> {
    try {
      return await this.ipc.invoke('auth:register', { username, password });
    } catch {
      return { ok: false, error: 'REGISTER_UNAVAILABLE' };
    }
  }

  // --- internals ---
  private setSession(user: User, token: string): void {
    this._user.set(user);
    this._token.set(token);
    this.persist();
  }

  private persist(): void {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify({
        token: this._token(),
        user:  this._user(),
      }));
    } catch { /* ignore */ }
  }

  private restore(): void {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (!raw) return;
      const { token, user } = JSON.parse(raw) as { token: string | null; user: User | null };
      this._token.set(token ?? null);
      this._user.set(user ?? null);
    } catch {
      localStorage.removeItem(this.STORAGE_KEY);
    }
  }
}
