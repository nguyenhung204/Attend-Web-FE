import { Component, OnInit, OnDestroy } from '@angular/core';
import { HttpService } from '../../services/http.service';
import { WebSocketService } from '../../services/websocket.service';
import {saveAs} from "file-saver";
import { Observable } from 'rxjs';

@Component({
  selector: 'app-attend-table',
  templateUrl: './attend-table.component.html',
  styleUrls: ['./attend-table.component.scss']
})
export class AttendTableComponent implements OnInit, OnDestroy {
  userList: any;
  attendanceList: any;
  filteredUserList: any[] = [];
  searchTerm: string = '';
  isLoading: boolean = true;

  constructor(
    public httpService: HttpService,
    private webSocketService: WebSocketService
  ) {
    this.httpService.getData().then((observable: Observable<any>) => {
      observable.subscribe((data: any) => {
        this.userList = data.sort((a: any, b: any) => a.MSSV.localeCompare(b.MSSV));
        this.filteredUserList = this.userList;
        console.log('Data loaded');
        this.syncAttendanceList();
        this.loadAttendanceFromLocalStorage();
        this.isLoading = false;
      });
    });
  }
 

  ngOnInit() {
    this.webSocketService.onAttendanceMarked((mssvList: string[]) => {
      console.log('Attendance marked for MSSVs:', mssvList);
      if (!Array.isArray(mssvList)) {
        mssvList = [mssvList];
      }
      this.markMultipleAttendances(mssvList);
      this.saveAttendanceToLocalStorage();
    });
  }


  ngOnDestroy() {
    console.log('AttendTableComponent destroyed');
    this.webSocketService.disconnect();
  }

  markAttendance(mssv: string): string | null {
    const student = this.interpolationSearch(mssv); 
    if (student) {
      // console.log('Found:', student);
      if (student.attendance) {
        // console.log('Already marked:', mssv);
        return mssv; // Return MSSV if already marked
      }
      student.attendance = new Date().toLocaleString();
      console.log('Updated:', mssv);
      return null; // Return null if marking is successful
    } else {
      console.log('Not found:', mssv);
      return null; 
    }
  }

  markMultipleAttendances(mssvList: string[]): string[] {
    const alreadyMarkedMSSVs: string[] = [];
    mssvList.forEach(mssv => {
      const result = this.markAttendance(mssv);
      if (result) {
        alreadyMarkedMSSVs.push(result);
      }
    });
    return alreadyMarkedMSSVs;
  }

  generateCSVContent(): string {
    const header = 'MSSV,Họ và tên,Điểm danh\n';
    const rows = this.userList
      .filter((item: any) => item.attendance)
      .map((item: any) => `${item.MSSV},${item.Name},${item.attendance}`)
      .join('\n');
    return '\uFEFF' + header + rows; // Add BOM for UTF-8 encoding
  }

  saveAttendanceToLocalStorage() {
    localStorage.setItem('attendanceList', JSON.stringify(this.userList));
  }

  loadAttendanceFromLocalStorage() {
    console.log('Loading attendance from local storage...');
    const savedList = localStorage.getItem('attendanceList');
    if (savedList) {
      this.userList = JSON.parse(savedList);
      this.filteredUserList = this.userList;
    } else {
      console.log('No attendance data found in local storage');
    }
  }

  downloadAttendanceList() {
    const csvContent = this.generateCSVContent();
    localStorage.setItem('attendanceCSV', csvContent);
    const contextLocal = localStorage.getItem('attendanceCSV');
    if (contextLocal) {
      const blob = new Blob([ contextLocal], {type: 'text/csv;charset=utf-8;'});
      saveAs(blob, 'attendance_list.csv');
    } else if (csvContent) {
      const blob = new Blob([csvContent], {type: 'text/csv;charset=utf-8;'});
      saveAs(blob, 'attendance_list.csv');
    }
    else {
      console.error('Error generating CSV content');
    }
  }

  interpolationSearch(mssv: string): any {
    let left = 0;
    let right = this.userList.length - 1;

    while (left <= right && mssv >= this.userList[left].MSSV && mssv <= this.userList[right].MSSV) {
      if (left === right) {
        if (this.userList[left].MSSV === mssv) return this.userList[left];
        return null;
      }

      // Calculate the position using interpolation formula
      const pos = left + Math.floor(
        ((parseInt(mssv) - parseInt(this.userList[left].MSSV)) * (right - left)) /
        (parseInt(this.userList[right].MSSV) - parseInt(this.userList[left].MSSV))
      );

      if (this.userList[pos].MSSV === mssv) {
        return this.userList[pos];
      }

      if (this.userList[pos].MSSV < mssv) {
        left = pos + 1;
      } else {
        right = pos - 1;
      }
    }
    return null;
  }

  filterUserList() {
    const searchTermLower = this.removeDiacritics(this.searchTerm.toLowerCase().trim());
    this.filteredUserList = this.userList.filter((user: any) => {
      const matchesSearchTerm = this.removeDiacritics(user.Name.toLowerCase()).includes(searchTermLower) ||
        user.MSSV.toLowerCase().includes(searchTermLower);
      const isAttended = user.attendance;

      if (searchTermLower === '/') {
        return isAttended;
      }
      return matchesSearchTerm;
    });
  }

  removeDiacritics(str: string): string {
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }
  
  async syncAttendanceList() {
    try {
      const observable = await this.httpService.attendData();
      observable.subscribe(
        (data: any) => {
          if (data && data.length > 0) {
            this.attendanceList = data.sort((a: any, b: any) => a.MSSV.localeCompare(b.MSSV));
            this.markMultipleAttendances(this.attendanceList.map((item: any) => item.MSSV));
            this.saveAttendanceToLocalStorage();
            console.log('Attendance list synced:', data);
          } else {
            console.log('No data received');
          }
        },
        (error: any) => {
          console.error('Error syncing attendance list:', error);
        },
        () => {
          console.log('Sync complete');
        }
      );
    } catch (error) {
      console.error('Error fetching attendance data:', error);
    }
  }

  
}