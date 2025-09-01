import {Component, computed, effect, inject, signal} from '@angular/core';
import {Router, RouterOutlet} from '@angular/router';
import {SidebarComponent, SideNavItem, SideUser, TopbarAction} from './features/sidebar/sidebar.component';
import {Crumb, TopbarComponent} from './topbar/topbar.component';
import {AuthService} from './core/auth.service';
import {Role} from '@shared/models';

type SideItemId = 'home' | 'items' | 'reports' | string;
type TopActionId = 'new' | 'export' | string;

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, SidebarComponent, TopbarComponent],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);

  // stato UI
  readonly isCollapsed = signal<boolean>(false);
  readonly isLoggedIn = this.auth.isLoggedIn; // <-- comodo in template

  readonly breadcrumbs = signal<Crumb[]>([
    { label: 'Home', route: '/' },
    { label: 'Dashboard' },
  ]);

  // VM utente per le barre
  readonly userVm = computed<SideUser | undefined>(() => {
    const u = this.auth.user();
    return u ? { name: u.username, role: u.role } : undefined;
  });

  readonly items = computed<SideNavItem[]>(() => {
    if (!this.isLoggedIn()) return [];
    const base: SideNavItem[] = [
      { id: 'home',  label: 'Home',  icon: 'bi bi-house',   route: '/' },
      { id: 'items', label: 'Items', icon: 'bi bi-archive', route: '/items' },
    ];
    return this.auth.role() === Role.ADMIN
      ? [...base]
      : base;
  });

  readonly actions = signal<TopbarAction[]>([
    { id: 'new',    label: 'New',    icon: 'bi bi-plus-lg',      variant: 'primary' },
  ]);

  constructor() {
    effect(() => {
      if (!this.auth.isLoggedIn()) {
        const url = this.router.url;
        if (!url.startsWith('/login')) void this.router.navigateByUrl('/login');
      }
    });
  }

  onSidebarCollapsed(collapsed: boolean) { this.isCollapsed.set(collapsed); }
  onSideItem(id: SideItemId) {
    switch (id) {
      case 'home':  void this.router.navigateByUrl('/'); break;
      default: void this.router.navigateByUrl(`/${id}`).catch(() => {}); break;
    }
  }
  onTopAction(id: TopActionId) {
    switch (id) {
      case 'new':    void this.router.navigateByUrl('/items/new'); break;
      case 'export': this.exportCurrentView(); break;
    }
  }
  async onLogout() { await this.auth.logout(); void this.router.navigateByUrl('/login'); }

  private exportCurrentView(): void {

  }
}
