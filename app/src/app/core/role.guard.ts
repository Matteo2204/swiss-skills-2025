import {CanActivateFn, Router} from '@angular/router';
import {inject} from '@angular/core';
import {AuthService} from './auth.service';
import {Role} from '@shared/models';

export const roleGuard = (roles: Role[]): CanActivateFn => () => {
  const auth = inject(AuthService), router = inject(Router);
  const r = auth.role();
  if (r && roles.includes(r)) return true;
  router.navigateByUrl('/'); // o pagina “Access denied”
  return false;
};
