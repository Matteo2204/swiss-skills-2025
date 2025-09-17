import {Component, Injector, ViewChild, computed, effect, inject, signal} from '@angular/core';
import {Router, RouterOutlet} from '@angular/router';
import {AuthService} from './core/auth.service';
import {Role} from '@shared/models';
import {Crumb} from '@shared/topbar/topbar.component';
import {SidebarComponent, SideNavItem, SideUser, TopbarAction} from '@shared/sidebar/sidebar.component';
import {StatusbarComponent} from '@shared/statusbar/statusbar.component';
import {ElementRef} from '@angular/core';
import {ConfigDialogComponent} from '@shared/config/config-dialog.component';
import {AppConfigService} from './core/app-config.service';
import {RealtimeService} from '@shared/services/realtime.service';
import {ImportDialogComponent} from '@shared/import/import-dialog.component';

type SideItemId = 'home' | 'reports' | string;
type TopActionId = 'import' | 'export' | string;

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, SidebarComponent, StatusbarComponent, ConfigDialogComponent, ImportDialogComponent],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  @ViewChild('cfgDlg', { static: false }) cfgDlg?: ConfigDialogComponent;
  @ViewChild('importDlg', { static: false }) importDlg?: ImportDialogComponent;
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly appCfg = inject(AppConfigService);
  // Wire realtime so it starts observing selection and connection state
  readonly rt = inject(RealtimeService);
  private readonly injector = inject(Injector);

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
      { id: 'home',            label: 'Home',            icon: 'bi bi-house',     route: '/' },
      { id: 'remote-control',  label: 'Remote Control',  icon: 'bi bi-joystick',  route: '/remote-control' },
      { id: 'messages',        label: 'Messages',        icon: 'bi bi-chat-dots', route: '/messages' },
    ];
    return this.auth.role() === Role.ADMIN
      ? [...base]
      : base;
  });

  readonly actions = signal<TopbarAction[]>([
    { id: 'import', label: 'Import', icon: 'bi bi-file-earmark-arrow-up', variant: 'outline-secondary' },
  ]);

  constructor() {
    this.auth.ready().then(() => {
      effect(() => {
        if (!this.auth.isLoggedIn()) {
          const url = this.router.url;
          if (!url.startsWith('/login')) void this.router.navigateByUrl('/login');
        }
      }, { injector: this.injector });
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
      case 'import': this.importDlg?.open(); break;
      case 'export': this.exportCurrentView(); break;
    }
  }
  async onLogout() { await this.auth.logout(); void this.router.navigateByUrl('/login'); }

  private exportCurrentView(): void {

  }

  onStatusbarDblClick(): void {
    // Ensure service is initialized (injected in ctor already)
    // Open the dialog
    this.cfgDlg?.open();
  }
}
