import { Injectable } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { CheckInMethod } from './http.service';
export interface AttendancePushedEvent { attendanceId: string; eventId: string; studentId: string; mssv: string; method: CheckInMethod; checkedInAt: string; }

@Injectable({ providedIn: 'root' })
export class WebSocketService {
  private readonly socket: Socket = io(window.location.origin, {
    path: '/api/socket.io',
    transports: ['websocket'],
  });
  private currentEventId?: string;
  constructor() { this.socket.on('connect', () => { if (this.currentEventId) this.socket.emit('attendance.subscribe', { eventId: this.currentEventId }); }); }
  subscribe(eventId: string, callback: (event: AttendancePushedEvent) => void): void {
    if (this.currentEventId && this.currentEventId !== eventId) this.socket.emit('attendance.unsubscribe', { eventId: this.currentEventId });
    this.currentEventId = eventId; this.socket.emit('attendance.subscribe', { eventId });
    this.socket.off('attendance.checked-in'); this.socket.on('attendance.checked-in', callback);
  }
  disconnect(): void { this.socket.disconnect(); this.currentEventId = undefined; }
}
