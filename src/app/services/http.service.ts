import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';

export type CheckInMethod = 'QR' | 'BARCODE' | 'MANUAL';
export interface EventSummary { eventId: string; name: string; status: 'DRAFT' | 'OPEN' | 'CLOSED' | 'CANCELLED'; checkInStartAt: string; checkInEndAt: string; }
export interface Attendance { attendanceId: string; studentId: string; mssv: string; method: CheckInMethod; checkedInAt: string; requestId: string; }
export interface CheckInLog { requestId: string; mssv: string; result: string; level: 'INFO' | 'WARN' | 'ERROR'; errorCode?: string; createdAt: string; }
export interface EventDashboard { event: EventSummary; registeredCount: number; checkedInCount: number; attendance: Attendance[]; logs: CheckInLog[]; }
export interface CheckInResult { status: 'CHECKED_IN' | 'ALREADY_CHECKED_IN'; attendanceId: string; eventId: string; studentId: string; mssv: string; fullName: string; method: CheckInMethod; checkedInAt: string; replayed: boolean; }
export interface CreateEventInput { name: string; status: EventSummary['status']; checkInStartAt: string; checkInEndAt: string; }
export interface ImportStudentsResult { rowsRead: number; accepted: number; studentsCreated: number; registrationsCreated: number; rejected: { row: number; reason: string }[]; }
export interface RegisteredStudent { studentId: string; mssv: string; fullName: string; createdAt: string; }
export interface Student extends RegisteredStudent { updatedAt: string; }
export interface StudentsResult { data: Student[]; total: number; page?: number; limit?: number; totalPages?: number; }

@Injectable({ providedIn: 'root' })
export class HttpService {
  // Requests stay same-origin. Angular dev proxy forwards /api to NestJS, which
  // lets an HTTPS tunnel expose the scanner and its API through one URL.
  private readonly apiUrl = '/api';
  constructor(private readonly http: HttpClient) {}
  health(): Observable<{ status: 'ok'; mongo: 'connected' }> { return this.http.get<{ status: 'ok'; mongo: 'connected' }>(`${this.apiUrl}/health`); }
  getEvents(): Observable<EventSummary[]> { return this.http.get<EventSummary[]>(`${this.apiUrl}/events`); }
  getStudents(page?: number, limit?: number): Observable<StudentsResult> {
    const params = new URLSearchParams();
    if (page !== undefined) params.set('page', String(page));
    if (limit !== undefined) params.set('limit', String(limit));
    const query = params.toString();
    return this.http.get<StudentsResult>(`${this.apiUrl}/students${query ? `?${query}` : ''}`);
  }
  getDashboard(eventId: string): Observable<EventDashboard> { return this.http.get<EventDashboard>(`${this.apiUrl}/events/${encodeURIComponent(eventId)}/dashboard`); }
  checkIn(eventId: string, mssv: string, method: CheckInMethod, requestId: string = crypto.randomUUID()): Observable<CheckInResult> {
    return this.http.post<CheckInResult>(`${this.apiUrl}/events/${encodeURIComponent(eventId)}/check-ins`, { mssv, method }, { headers: new HttpHeaders({ 'Idempotency-Key': requestId }) });
  }
  createEvent(input: CreateEventInput): Observable<EventSummary> { return this.http.post<EventSummary>(`${this.apiUrl}/events`, input); }
  importStudents(eventId: string, file: File): Observable<ImportStudentsResult> { const body = new FormData(); body.append('file', file); return this.http.post<ImportStudentsResult>(`${this.apiUrl}/events/${encodeURIComponent(eventId)}/students/import`, body); }
  getRegistrations(eventId: string, limit = 1000): Observable<RegisteredStudent[]> { return this.http.get<RegisteredStudent[]>(`${this.apiUrl}/events/${encodeURIComponent(eventId)}/registrations?limit=${limit}`); }
}
