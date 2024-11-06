import { Component } from '@angular/core';
import { Router } from '@angular/router';

@Component({
  selector: 'app-login',
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.scss']
})
export class LoginComponent {
  username: string = '';
  password: string = '';

  constructor(private router: Router) {}

  onLogin() {

    if (this.username === 'admin' && this.password === 'password') {
      localStorage.setItem('isAuthenticated', 'true');
      this.router.navigate(['/attends']);
    } else {
      alert('Invalid credentials');
    }
  }
}
