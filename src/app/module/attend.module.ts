import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { AttendTableComponent } from './attend-table/attend-table.component';
import { AttendRoutingModule } from './attend-routing.module';

@NgModule({
  declarations: [
    AttendTableComponent
  ],
  imports: [
    AttendRoutingModule,
    CommonModule,
    RouterModule,
    FormsModule,
  ]
})
export class AttendModule { }
