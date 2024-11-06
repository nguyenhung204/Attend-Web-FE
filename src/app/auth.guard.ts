import { CanActivateFn } from '@angular/router';
import { Router } from '@angular/router';

export const authGuard: CanActivateFn = (route, state) => {
  const isAuthenticated = !!localStorage.getItem('isAuthenticated');
  if (!isAuthenticated) {
    const router = new Router();
    router.navigate(['']);
    return false;
  }
  return true;
};
