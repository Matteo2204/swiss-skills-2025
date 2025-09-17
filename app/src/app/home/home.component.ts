import {Component, computed} from '@angular/core';
import {AuthService} from '../core/auth.service';
import {RouterLink} from '@angular/router';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [
    RouterLink
  ],
  templateUrl: './home.component.html',
  styleUrl: './home.component.css'
})
export class HomeComponent {
  role = computed(() => this.auth.role());
  constructor(private auth: AuthService) {}
  logout() { this.auth.logout(); }
}
