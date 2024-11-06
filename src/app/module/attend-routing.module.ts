import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { LoginComponent } from './login/login.component';
import {AttendTableComponent} from "./attend-table/attend-table.component";
import {authGuard} from "../auth.guard";


const routes: Routes = [
  { path: '', component: LoginComponent },
  { path: 'attends', component: AttendTableComponent, canActivate: [authGuard] }
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule]
})
export class AttendRoutingModule{ }
