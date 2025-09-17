import {InjectionToken} from '@angular/core';

// Minimal client config surface used by UI components.
// Loader/wiring provided by a dedicated task; components should tolerate absence.
export interface ClientConfig {
  // Percentage [5,50]; default 20 when not provided by loader.
  batteryLowThresholdPercent?: number;
  // Minutes [1,60]; default 5 when not provided by loader.
  stuckThresholdMinutes?: number;
}

export const CLIENT_CONFIG = new InjectionToken<ClientConfig>('CLIENT_CONFIG');
