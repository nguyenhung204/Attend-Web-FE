import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { AttendTableComponent } from './module/attend-table/attend-table.component';

const routes: Routes = [
  {
    path: '',
    loadChildren: () => import('./module/attend.module').then(m => m.AttendModule)
  },
  {
    path : 'attends',
    component : AttendTableComponent,
  }
];

@NgModule({
  imports: [RouterModule.forRoot(routes, {
    initialNavigation: 'enabledBlocking'
  })],
  exports: [RouterModule]
})
export class AppRoutingModule { }
