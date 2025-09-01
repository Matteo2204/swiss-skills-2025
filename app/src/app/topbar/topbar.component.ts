import {
  ChangeDetectionStrategy, Component, input, output
} from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import type { SideNavItem, TopbarAction, SideUser } from '../features/sidebar/sidebar.component';
import {NgOptimizedImage} from '@angular/common';

export interface Crumb { label: string; route?: string; }

@Component({
  selector: 'app-topbar',
  imports: [RouterLink, RouterLinkActive, NgOptimizedImage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'd-block border-bottom' },
  templateUrl: './topbar.component.html',
})
export class TopbarComponent {
  title = input.required<string>();
  logo  = input<string | undefined>();

  items = input<SideNavItem[] | undefined>(undefined);

  breadcrumbs = input<Crumb[] | undefined>(undefined);
  actions = input<TopbarAction[] | undefined>(undefined);
  user = input<SideUser | undefined>(undefined);

  action = output<string>();
  itemClick = output<string>();
  signOut = output<void>();

  onAction(id: string) { this.action.emit(id); }
  onItem(it: SideNavItem) { if (!it.disabled) this.itemClick.emit(it.id); }
  onSignOut() { this.signOut.emit(); }
}
