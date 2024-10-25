import { NgModule } from "@angular/core";
import { AttendTableComponent } from "./attend-table/attend-table.component";
import { CommonModule } from "@angular/common";
import { RouterModule } from "@angular/router";
import { AttendRoutingModule } from "./attend-routing.module";

@NgModule({
  declarations: [
    AttendTableComponent
  ],
  imports: [
    AttendRoutingModule,
    CommonModule,
    RouterModule
  ],
  providers: [
   
  ]
})
export class AttendModule { }
