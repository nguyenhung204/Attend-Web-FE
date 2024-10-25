import { RouterModule, Routes } from "@angular/router";
import { AttendTableComponent } from "./attend-table/attend-table.component";
import { NgModule } from "@angular/core";

export const routes: Routes = [
    {
        path: '',
        component: AttendTableComponent
    }
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule]
})
export class AttendRoutingModule { }