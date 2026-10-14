import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';

export type Role = 'SYSTEM' | 'ADMIN' | 'MEMBER';
export type TicketStatus = 'VALID' | 'USED' | 'CANCELLED';
export type ScanOutcome = 'ADMITTED' | 'REJECTED_ALREADY_USED' | 'REJECTED_NOT_FOUND' | 'REJECTED_CANCELLED' | 'UNDONE';
export type ScanEntryMode = 'AUTO_SCAN' | 'MANUAL' | 'QR' | 'BARCODE';

export interface ApiError {
  error: string;
  message: string;
  requestId?: string;
  problems?: Array<{ index: number; message: string }>;
}

export interface Profile {
  zaloId: string;
  name: string;
  avatarUrl?: string;
}

export interface Account {
  accountId: string;
  displayName: string;
  phone?: string;
  role: Role;
  status: string;
  bound: boolean;
  unitId?: string | null;
  unitName?: string | null;
  ownerAccountId?: string | null;
  ownerName?: string | null;
}

export interface Unit {
  unitId: string;
  name: string;
  eventQuota: number;
  eventsCreated: number;
  eventsLeft: number;
  note?: string;
  createdAt: number;
  [key: string]: unknown;
}

export interface MeResponse {
  profile: Profile;
  account: Account | null;
  role: Role | null;
  unit: Unit | null;
}

export interface EventSummary {
  eventId: string;
  name: string;
  venue?: string;
  gateId?: string;
  gateName?: string;
  scheduleLabel?: string;
  eventDate?: string;
  startsAt?: string;
  endsAt?: string;
  allDay?: boolean;
  isLive: boolean;
  soldCount: number;
  gateCountLabel?: string;
  ticketCodeLength: number;
  rosterVersion: number;
  dedupeEnabled?: boolean;
  unitId?: string;
  unitName?: string;
  ownerAccountId?: string | null;
}

export interface Ticket {
  ticketCode: string;
  holderName: string;
  holderRole?: string;
  ticketType?: string;
  seat?: string;
  status: TicketStatus;
  checkedInAt?: number | null;
  checkedInAtGate?: string | null;
  revision?: number;
  rowVersion?: number;
  deleted?: boolean;
}

export interface RosterPage {
  tickets: Ticket[];
  nextCursor: string | null;
  version: number;
}

export interface ScanRequest {
  clientEventId: string;
  eventId: string;
  gateId: string;
  ticketCode: string;
  outcome: ScanOutcome;
  undoesEventId?: string | null;
  scannedAtWallClock: number;
  deviceSeq: number;
  deviceId: string;
  entryMode: ScanEntryMode;
}

export interface ScanRecord extends ScanRequest {
  gateName?: string;
  holderName?: string;
  holderRole?: string;
  scannedByAccountId?: string;
  scannedByName?: string;
  accepted: boolean;
  conflictReason?: string | null;
  serverReceivedAt: number;
}

export interface ScanFeed {
  scans: ScanRecord[];
  nextSince: number;
}

export interface ScanAcknowledgement {
  clientEventId: string;
  accepted: boolean;
  conflictReason?: string | null;
  duplicate?: boolean;
}

@Injectable({ providedIn: 'root' })
export class HttpService {
  /** Same-origin keeps the existing HttpOnly cookie flow working through the production/dev proxy. */
  private readonly apiUrl = '/bcn/templekeeper/';
  private readonly accessTokenKey = 'templekeeper.pwa-access-token';

  constructor(private readonly http: HttpClient) { }

  get accessToken(): string {
    try { return localStorage.getItem(this.accessTokenKey)?.trim() ?? ''; }
    catch { return ''; }
  }

  get hasAccessToken(): boolean { return !!this.accessToken; }

  saveAccessToken(value: string): void {
    const token = value.trim().replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      this.clearAccessToken();
      return;
    }
    try { localStorage.setItem(this.accessTokenKey, token); }
    catch { throw new Error('Không thể lưu mã truy cập trên thiết bị.'); }
  }

  clearAccessToken(): void {
    try { localStorage.removeItem(this.accessTokenKey); } catch { /* Storage may be unavailable. */ }
  }

  health(): Observable<{ ok: true; service: 'templekeeper' }> {
    return this.http.get<{ ok: true; service: 'templekeeper' }>(this.url('health'), this.requestOptions());
  }

  me(): Observable<MeResponse> {
    return this.http.get<MeResponse>(this.url('me'), this.requestOptions());
  }

  loginWithZalo(credentials: { oauthCode?: string; accessToken?: string; codeVerifier?: string }): Observable<{ accessToken: string; profile: Profile; role: Role | null }> {
    return this.http.post<{ accessToken: string; profile: Profile; role: Role | null }>(this.url('auth/zalo'), credentials, this.requestOptions());
  }

  webLoginUrl(): string { return new URL(this.url('auth/web/start'), window.location.origin).toString(); }

  logout(): Observable<void> {
    return this.http.post<void>(this.url('auth/web/logout'), {}, this.requestOptions());
  }

  getEvents(gateId?: string): Observable<EventSummary[]> {
    const params = gateId ? new HttpParams().set('gateId', gateId) : undefined;
    return this.http.get<EventSummary[]>(this.url('events'), this.requestOptions(params));
  }

  getRoster(eventId: string, cursor = '0', since = 0): Observable<RosterPage> {
    const params = new HttpParams().set('cursor', cursor).set('since', String(since));
    return this.http.get<RosterPage>(this.url(`events/${this.segment(eventId)}/roster`), this.requestOptions(params));
  }

  getScans(eventId: string, since = 0, limit = 500, order: 'asc' | 'desc' = 'asc'): Observable<ScanFeed> {
    const params = new HttpParams().set('since', String(since)).set('limit', String(limit)).set('order', order);
    return this.http.get<ScanFeed>(this.url(`events/${this.segment(eventId)}/scans`), this.requestOptions(params));
  }

  postScans(scans: ScanRequest[]): Observable<{ acks: ScanAcknowledgement[] }> {
    return this.http.post<{ acks: ScanAcknowledgement[] }>(this.url('scans'), { scans }, this.requestOptions());
  }

  private requestOptions(params?: HttpParams): {
    withCredentials: true;
    headers: Record<string, string>;
    params?: HttpParams;
  } {
    const token = this.accessToken;
    return {
      withCredentials: true,
      headers: token ? { Authorization: 'Bearer ' + token } : {},
      ...(params ? { params } : {}),
    };
  }

  private url(path: string): string { return this.apiUrl + path.replace(/^\//, ''); }
  private segment(value: string): string { return encodeURIComponent(value); }
}
