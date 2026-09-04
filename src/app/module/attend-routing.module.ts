import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { AttendTableComponent } from './attend-table/attend-table.component';

const routes: Routes = [
  { path: '', component: AttendTableComponent },
  { path: '**', redirectTo: '' }
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule]
})
export class AttendRoutingModule { }
