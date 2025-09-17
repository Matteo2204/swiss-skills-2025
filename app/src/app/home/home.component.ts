import {Component, computed, inject} from '@angular/core';
import {DeviceSelectorComponent} from '@shared/device-selector/device-selector.component';
import {OverviewHeaderComponent} from '@shared/overview-header/overview-header.component';
import {DeviceSelectionService} from '@shared/services/device-selection.service';
import {BatteryTrendComponent} from '@shared/battery-trend/battery-trend.component';
import {StateAnalyticsComponent} from '@shared/state-analytics/state-analytics.component';
import {AuthService} from '../core/auth.service';
import {GpsMapComponent} from '@shared/gps-map/gps-map.component';
// Import/Export dialogs will be opened from elsewhere; not embedded here to avoid layout issues.

@Component({
  selector: 'app-home',
  imports: [DeviceSelectorComponent, OverviewHeaderComponent, BatteryTrendComponent, StateAnalyticsComponent, GpsMapComponent],
  templateUrl: './home.component.html',
  styleUrl: './home.component.css'
})
export class HomeComponent {
  private readonly auth = inject(AuthService);
  readonly ds = inject(DeviceSelectionService);

  role = computed(() => this.auth.role());

  async logout() { await this.auth.logout(); }

  // (Import/Export openers moved out for isolation)
}
