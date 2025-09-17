import {ChangeDetectionStrategy, Component, inject} from '@angular/core';
import {RealtimeService} from '../services/realtime.service';

@Component({
  selector: 'app-statusbar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'd-flex align-items-center justify-content-between app-statusbar px-3 py-1 border-top bg-body',
    // Nota: doppio-click riservato alla config → non gestito qui
  },
  templateUrl: './statusbar.component.html',
  styleUrl: './statusbar.component.css',
})
export class StatusbarComponent {
  readonly rt = inject(RealtimeService);
}

