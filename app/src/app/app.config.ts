import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import {provideAnimations} from '@angular/platform-browser/animations';
import {provideToastr} from 'ngx-toastr';
import {provideAnimationsAsync} from '@angular/platform-browser/animations/async';
import {MessageEngineService} from '@shared/services/message-engine.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideAnimations(),
    provideAnimationsAsync(),
    provideToastr(),
    // Expose message counts to OverviewHeader via provider contract
    { provide: 'OverviewMessagesProvider', useExisting: MessageEngineService }
  ]
};
