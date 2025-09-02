import {CanActivateFn, Router} from '@angular/router';
import {inject} from '@angular/core';
import {AuthService} from './auth.service';

export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  // Ensure auth init (auto-login) completed before deciding
  await auth.ready();
  if (auth.isLoggedIn()) return true;
  await router.navigateByUrl('/login');
  return false;
};
