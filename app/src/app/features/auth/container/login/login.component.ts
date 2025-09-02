// app/features/auth/login/login.component.ts
import { Component, signal, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../../../core/auth.service';

@Component({
  selector: 'app-login',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="container py-5" style="max-width:420px;">
      <h1 class="h3 mb-3 fw-bold">Sign in</h1>
      <p class="text-muted mb-4">Enter your credentials to continue.</p>

      <form (ngSubmit)="submit()" class="d-flex flex-column gap-2">
        <input class="form-control" [(ngModel)]="username" name="u" placeholder="Username" required>
        <input class="form-control" [(ngModel)]="password" name="p" placeholder="Password" type="password" required>
        <label class="d-flex align-items-center gap-2 text-muted" style="font-size: .95rem;">
          <input type="checkbox" [(ngModel)]="remember" name="r">
          Ricordami su questo dispositivo
        </label>
        <button class="btn btn-primary mt-2" type="submit">Sign in</button>
      </form>

      @if (error()) {
        <p class="mt-2 text-danger">Invalid credentials</p>
      }

      <hr class="my-4" />
      <div class="d-flex justify-content-between">
        <span class="text-muted">Don’t have an account?</span>
        <a [routerLink]="['/register']" class="link-primary">Create one</a>
      </div>
    </div>
  `
})
export class LoginComponent {
  username = '';
  password = '';
  remember = false;
  error = signal(false);

  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  async submit() {
    this.error.set(false);
    const ok = await this.auth.login(this.username, this.password, this.remember);
    if (ok) this.router.navigateByUrl('/');
    else this.error.set(true);
  }
}
