// app/features/auth/register/register.component.ts
import { Component, computed, inject, signal } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { AuthService } from '../../../../core/auth.service';

@Component({
  selector: 'app-register',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './register.html',
  styleUrl: './register.css'
})
export class Register {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly form = this.fb.nonNullable.group({
    username: ['', [Validators.required, Validators.minLength(3)]],
    password: ['', [Validators.required, Validators.minLength(6)]],
    confirm : ['', [Validators.required]],
  });

  // bridge: Observables -> Signals
  private readonly passwordSig = toSignal(
    this.form.controls.password.valueChanges,
    { initialValue: this.form.controls.password.value }
  );
  private readonly confirmSig = toSignal(
    this.form.controls.confirm.valueChanges,
    { initialValue: this.form.controls.confirm.value }
  );

  // UI state
  readonly submitting = signal(false);
  readonly errorMsg = signal<string | null>(null);

  // derived state (ora reattivo davvero)
  readonly passwordsMismatch = computed(() =>
    (this.passwordSig() ?? '') !== (this.confirmSig() ?? '')
  );

  async submit(): Promise<void> {
    this.errorMsg.set(null);
    if (this.form.invalid || this.passwordsMismatch()) {
      this.form.markAllAsTouched();
      if (this.passwordsMismatch()) this.errorMsg.set('Passwords do not match');
      return;
    }

    this.submitting.set(true);
    const { username, password } = this.form.getRawValue();
    try {
      const res = await this.auth.register(username, password);
      if (res.ok) {
        await this.router.navigateByUrl('/login');
        return;
      }
      this.errorMsg.set(res.error ?? 'Registration failed');
    } catch {
      this.errorMsg.set('Unexpected error during registration');
    } finally {
      this.submitting.set(false);
    }
  }
}
