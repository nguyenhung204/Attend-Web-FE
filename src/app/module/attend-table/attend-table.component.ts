import { Component, OnInit, OnDestroy } from '@angular/core';
import { HttpService } from '../../services/http.service';
import { WebSocketService } from '../../services/websocket.service';
import { saveAs } from 'file-saver';

@Component({
  selector: 'app-attend-table',
  templateUrl: './attend-table.component.html',
  styleUrls: ['./attend-table.component.scss']
})
export class AttendTableComponent implements OnInit, OnDestroy {
  userList: any;

  constructor(
    public httpService: HttpService,
    private webSocketService: WebSocketService
  ) { }

  ngOnInit() {
    console.log('AttendTableComponent initialized');

    // Lấy dữ liệu từ API
    console.log('Getting data from API');
    this.httpService.getData().subscribe((data: any) => {
      this.userList = data;
      console.log('Data loaded');
      this.loadAttendanceFromLocalStorage();
    });

    // Kết nối WebSocket và lắng nghe sự kiện 'attendanceMarked'
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
    // Đóng kết nối WebSocket khi component bị hủy
    this.webSocketService.disconnect();
  }

  markAttendance(mssv: string): string | null {
    const student = this.userList.find((item: any) => item.MSSV === mssv);
    if (student) {
      console.log('Found:', student);
      if (student.attendance) {
        console.log('Already marked:', mssv);
        return mssv; // Return MSSV if already marked
      }
      student.attendance = new Date().toLocaleString();
      console.log('Updated:', mssv);
      return null; // Return null if marking is successful
    } else {
      console.log('Not found:', mssv);
      return null; // Return null if student not found
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
    const savedList = localStorage.getItem('attendanceList');
    if (savedList) {
      this.userList = JSON.parse(savedList);
    }
  }

  downloadAttendanceList() {
    const csvContent = this.generateCSVContent();
    localStorage.setItem('attendanceCSV', csvContent);

    const contextLocal = localStorage.getItem('attendanceCSV');
    if (contextLocal || csvContent) {
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      saveAs(blob, 'attendance_list.csv');
    }
  }
}
