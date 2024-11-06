import { NgModule } from "@angular/core";
import { AttendTableComponent } from "./attend-table/attend-table.component";
import { CommonModule } from "@angular/common";
import { RouterModule } from "@angular/router";
import {FormsModule} from "@angular/forms";
import {LoginComponent} from "./login/login.component";
import {AttendRoutingModule} from "./attend-routing.module";

@NgModule({
  declarations: [
    AttendTableComponent,
    LoginComponent
  ],
  imports: [
    AttendRoutingModule,
    CommonModule,
    RouterModule,
    FormsModule,
  ],
  providers: [

  ]
})
export class AttendModule { }
