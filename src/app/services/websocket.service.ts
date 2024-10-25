import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';

@Injectable({
  providedIn: 'root'
})
export class WebSocketService {
  private socket: Socket;

  constructor() {
    this.socket = io('ws://localhost:4000/', {
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
