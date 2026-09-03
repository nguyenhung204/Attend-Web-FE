import { Component, OnDestroy, OnInit } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { CreateEventInput, EventDashboard, EventSummary, HttpService, ImportStudentsResult, RegisteredStudent } from '../../services/http.service';
import { WebSocketService } from '../../services/websocket.service';
@Component({ selector: 'app-admin', templateUrl: './admin.component.html', styleUrls: ['./admin.component.scss'] })
export class AdminComponent implements OnInit, OnDestroy {
  events: EventSummary[] = []; selectedEventId = ''; dashboard?: EventDashboard; registrations: RegisteredStudent[] = []; selectedFile?: File; importResult?: ImportStudentsResult; message = ''; isError = false; isSaving = false; studentSearch = '';
  create: CreateEventInput = { name: 'Sinh hoạt đầu năm K22', status: 'OPEN', checkInStartAt: '', checkInEndAt: '' };
  constructor(private readonly api: HttpService, private readonly socket: WebSocketService) {}
  ngOnInit(): void { this.loadEvents(); } ngOnDestroy(): void { this.socket.disconnect(); }
  loadEvents(selected?: string): void { this.api.getEvents().subscribe({ next: events => { this.events = events; this.selectedEventId = selected ?? this.selectedEventId ?? events[0]?.eventId ?? ''; if (!this.selectedEventId && events.length) this.selectedEventId = events[0].eventId; this.refreshDashboard(); }, error: error => this.showError(error) }); }
  refreshDashboard(): void { if (!this.selectedEventId) { this.dashboard = undefined; return; } this.socket.subscribe(this.selectedEventId, () => this.fetchDashboard()); this.fetchDashboard(); }
  fetchDashboard(): void { if (this.selectedEventId) { this.api.getDashboard(this.selectedEventId).subscribe({ next: dashboard => this.dashboard = dashboard, error: error => this.showError(error) }); this.api.getRegistrations(this.selectedEventId).subscribe({ next: students => this.registrations = students, error: error => this.showError(error) }); } }
  createEvent(): void { this.isSaving = true; this.api.createEvent({ ...this.create, status: 'OPEN', checkInStartAt: new Date(this.create.checkInStartAt).toISOString(), checkInEndAt: new Date(this.create.checkInEndAt).toISOString() }).subscribe({ next: event => { this.message = 'Đã tạo sự kiện.'; this.isError = false; this.loadEvents(event.eventId); }, error: error => this.showError(error), complete: () => this.isSaving = false }); }
  setFile(event: Event): void { this.selectedFile = (event.target as HTMLInputElement).files?.[0]; }
  importStudents(): void { if (!this.selectedFile || !this.selectedEventId) return; this.isSaving = true; this.api.importStudents(this.selectedEventId, this.selectedFile).subscribe({ next: result => { this.importResult = result; this.message = 'Import thành công.'; this.isError = false; this.fetchDashboard(); }, error: error => this.showError(error), complete: () => this.isSaving = false }); }
  get rate(): number {
    const registeredCount = this.dashboard?.registeredCount ?? 0;
    const checkedInCount = this.dashboard?.checkedInCount ?? 0;
    return registeredCount ? Math.round((checkedInCount / registeredCount * 100) * 10) / 10 : 0;
  }
  hasCheckedIn(mssv: string): boolean { return this.dashboard?.attendance.some(item => item.mssv === mssv) ?? false; }
  getCheckedInAt(mssv: string): string | null { return this.dashboard?.attendance.find(item => item.mssv === mssv)?.checkedInAt ?? null; }
  get filteredRegistrations(): RegisteredStudent[] { const query = this.studentSearch.trim().toLowerCase(); return query ? this.registrations.filter(student => student.mssv.toLowerCase().includes(query) || student.fullName.toLowerCase().includes(query)) : this.registrations; }
  private showError(error: HttpErrorResponse): void { this.isError = true; this.message = error.error?.message || error.error?.code || 'Yêu cầu thất bại.'; this.isSaving = false; }
}
