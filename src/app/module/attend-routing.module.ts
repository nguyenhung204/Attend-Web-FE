import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { AttendTableComponent } from './attend-table/attend-table.component';
import { AdminComponent } from './admin/admin.component';
const routes: Routes = [
  { path: '', component: AttendTableComponent },
  { path: 'admin', component: AdminComponent },
  { path: 'attends', redirectTo: '' }
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule]
})
export class AttendRoutingModule{ }
