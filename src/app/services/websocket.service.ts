import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';

@Injectable({
  providedIn: 'root'
})
export class WebSocketService {
  private socket: Socket;
  private attendanceData: any[] = [];

  constructor() {
    this.socket = io('ws://172.20.121.208:4500/', {
      transports: ['websocket']
    });

    this.socket.on('connect', () => {
      console.log('WebSocket connected');
    });

    this.socket.on('disconnect', () => {
      console.log('WebSocket disconnected');
    });

    this.socket.on('error', (error: any) => {
      console.error('WebSocket error:', error);
    });

    this.socket.on('requestAttendanceData', () => {
      this.sendAttendanceData();
    });
  }

  private sendAttendanceData() {
    const attendanceData = localStorage.getItem('attendanceList');
    if (attendanceData) {
      const attendedStudents = JSON.parse(attendanceData).filter((student: any) => student.attendance);
      this.socket.emit('attendanceData', attendedStudents);

    } else {
      console.log('No attendance data found in localStorage');
    }
  }




  onAttendanceMarked(callback: (mssvList: string[]) => void) {
    this.socket.on('attendanceMarked', (data: any) => {
      const mssvArray = Array.isArray(data.mssvArray) ? data.mssvArray : data.mssvArray.split(',');
      callback(mssvArray);
      console.log( 'MSSV:', mssvArray);
    });
  }


  disconnect() {
    this.socket.disconnect();
  }
}
