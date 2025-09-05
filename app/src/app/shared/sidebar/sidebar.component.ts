import {
  ChangeDetectionStrategy, Component, computed, input, output, signal
} from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import {NgOptimizedImage} from '@angular/common';

export interface SideNavItem {
  id: string;
  label: string;
  icon?: string;
  route?: string;     // se presente, naviga con RouterLink
  badge?: number;
  disabled?: boolean;
}

export interface SideUser {
  name: string;
  role?: string | undefined;
}

export interface TopbarAction {
  id: string;
  label: string;
  icon?: string;
  variant?: 'primary' | 'outline-secondary' | 'secondary';
  disabled?: boolean;
}

@Component({
  selector: 'app-sidebar',
  imports: [RouterLink, RouterLinkActive, NgOptimizedImage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'd-flex flex-column h-100 border-end app-sidebar',
    '[style.width.px]': 'isCollapsed() ? 78 : 280',
    '[class.is-collapsed]': 'isCollapsed()',
    style: 'transition: width 160ms ease; flex: 0 0 auto;'
  },
  templateUrl: './sidebar.component.html',
})
export class SidebarComponent {
  // Inputs
  title = input.required<string>();
  logo  = input<string | undefined>();
  items = input<SideNavItem[]>([]);
  user  = input<SideUser | undefined>();
  collapsed = input<boolean>(false);
  actions = input<TopbarAction[] | undefined>(undefined); // per parity con topbar

  // Outputs
  collapseChange = output<boolean>();
  itemClick = output<string>();
  action = output<string>();
  signOut = output<void>();

  // Stato locale (solo per item senza route)
  protected selectedId = signal<string | null>(null);

  isCollapsed = computed(() => this.collapsed());
  toggle() { this.collapseChange.emit(!this.isCollapsed()); }

  // click item: se ha route -> RouterLink gestisce la navigazione
  // comunque emettiamo sempre l'evento al container
  onItemClick(it: SideNavItem) {
    if (it.disabled) return;
    if (!it.route) this.selectedId.set(it.id);
    this.itemClick.emit(it.id);
  }
  exactFor(route?: string | null): boolean {
    return route === '/' || route === undefined || route === null;
  }

  onActionClick(id: string) { this.action.emit(id); }
  onSignOut() { this.signOut.emit(); }
}
