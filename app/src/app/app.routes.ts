import { Routes } from '@angular/router';
import {HomeComponent} from './home/home.component';
import {authGuard} from '@core/auth.guard';
import {LoginComponent} from '@features/auth/container/login/login.component';
import {Register} from '@features/auth/container/register/register';
import {RemoteControlComponent} from './remote-control/remote-control.component';
import {MessagesPanelComponent} from '@shared/messages-panel/messages-panel.component';

export const routes: Routes = [
  { path: '', component: HomeComponent, canActivate: [authGuard] },
  { path: 'remote-control', component: RemoteControlComponent, canActivate: [authGuard] },
  { path: 'messages', component: MessagesPanelComponent, canActivate: [authGuard] },
  { path: 'login', component: LoginComponent },
  { path: 'register', component: Register },
  { path: '**', redirectTo: '' }
];
