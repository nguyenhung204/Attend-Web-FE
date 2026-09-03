import { NgModule } from "@angular/core";
import { AttendTableComponent } from "./attend-table/attend-table.component";
import { CommonModule } from "@angular/common";
import { RouterModule } from "@angular/router";
import {FormsModule} from "@angular/forms";
import {AttendRoutingModule} from "./attend-routing.module";
import { AdminComponent } from './admin/admin.component';
import { MatIconModule } from '@angular/material/icon';

@NgModule({
  declarations: [
    AttendTableComponent,
    AdminComponent
  ],
  imports: [
    AttendRoutingModule,
    CommonModule,
    RouterModule,
    FormsModule,
    MatIconModule,
  ],
  providers: [

  ]
})
export class AttendModule { }
