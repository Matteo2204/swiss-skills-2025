import { Routes } from '@angular/router';
import {HomeComponent} from './home/home.component';
import {authGuard} from '@core/auth.guard';
import {LoginComponent} from '@features/auth/container/login/login.component';
import {ItemsComponent} from '@features/items/container/items-component/items-component';
import {Register} from '@features/auth/container/register/register';

export const routes: Routes = [
  { path: '', component: HomeComponent, canActivate: [authGuard] },
  { path: 'items', component: ItemsComponent, canActivate: [authGuard] },
  { path: 'login', component: LoginComponent },
  { path: 'register', component: Register },
  { path: '**', redirectTo: '' }
];
