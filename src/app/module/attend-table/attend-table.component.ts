import { ChangeDetectorRef, Component, ElementRef, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { BrowserMultiFormatReader, IScannerControls } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType, Result } from '@zxing/library';
import { firstValueFrom } from 'rxjs';
import { EventSummary, HttpService, MeResponse, ScanEntryMode, ScanOutcome, ScanRecord, ScanRequest, Ticket } from '../../services/http.service';
import { OfflineCheckInQueueService, QueuedScan, ScanHistoryItem } from '../../services/offline-check-in-queue.service';

interface ScannerTrackCapabilities {
  focusMode?: string[];
  exposureCompensation?: { min: number; max: number; step?: number };
}

interface ScannerTrackSettings {
  focusDistance?: number;
}

type RecentCheckIn = ScanHistoryItem;
type ToastKind = 'success' | 'duplicate' | 'rejected' | 'info' | 'error';
@Component({ selector: 'app-attend-table', templateUrl: './scanner-shell.component.html', styleUrls: ['./scanner.component.scss'] })


export class AttendTableComponent implements OnInit, OnDestroy {
  @ViewChild('scannerVideo') scannerVideo?: ElementRef<HTMLVideoElement>;
  events: EventSummary[] = []; selectedEventId = ''; mssv = ''; method: ScanEntryMode = 'MANUAL';
  identity?: MeResponse;
  authState: 'loading' | 'login' | 'pending' | 'ready' = 'loading';
  accessCode = '';
  accessCodeError = '';
  showAccessCodeLogin = false;
  isValidatingAccessCode = false;
  readonly keypadDigits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
  activeTab: 'scan' | 'manual' | 'history' = 'scan';
  isEventPickerOpen = true;
  isLoading = true; isScanning = false; isSubmitting = false; torchAvailable = false; torchOn = false; toastMessage = ''; toastKind: ToastKind = 'info';
  pendingCount = 0; failedCount = 0; pendingRequestCount = 0; isSyncing = false; usingCachedEvents = false;
  rosterReady = false;
  queueItems: QueuedScan[] = [];
  recentCheckIns: RecentCheckIn[] = [];
  networkStatus: 'CHECKING' | 'ONLINE' | 'OFFLINE' = navigator.onLine ? 'CHECKING' : 'OFFLINE';
  private scannerControls?: IScannerControls; private toastTimer?: ReturnType<typeof setTimeout>; private syncTimer?: ReturnType<typeof setInterval>; private isCheckingConnectivity = false;
  private readonly activeScanKeys = new Set<string>();
  private readonly scanCooldowns = new Map<string, number>();
  private scannerReader?: BrowserMultiFormatReader;
  private scanModeTimer?: ReturnType<typeof setTimeout>;
  private focusLockTimer?: ReturnType<typeof setTimeout>;
  private isFallbackScanMode = false;
  private readonly priorityScanFormats = [BarcodeFormat.QR_CODE, BarcodeFormat.CODE_39];
  private readonly fallbackScanFormats = Object.values(BarcodeFormat).filter((format): format is BarcodeFormat => typeof format === 'number');
  private readonly priorityScanWindowMs = 850;
  private readonly fallbackQuietMs = 1200;
  private readonly scanCooldownMs = 2500;
  private readonly identityCacheKey = 'templekeeper.pwa-identity';
  private readonly onlineHandler = () => { void this.refreshConnectivity(true); };
  private readonly offlineHandler = () => { this.setNetworkStatus('OFFLINE'); };
  constructor(private readonly api: HttpService, private readonly offlineQueue: OfflineCheckInQueueService, private readonly zone: NgZone, private readonly changeDetector: ChangeDetectorRef) { }
  ngOnInit(): void {
    void this.requestPersistentStorage();
    void this.refreshQueueSummary();
    void this.refreshQueueItems();
    window.addEventListener('online', this.onlineHandler); window.addEventListener('offline', this.offlineHandler);
    this.syncTimer = setInterval(() => void this.refreshConnectivity(true), 15000);
    void this.loadIdentity();
    void this.refreshConnectivity(true);
  }
  ngOnDestroy(): void {
    this.stopScanner(); if (this.toastTimer) clearTimeout(this.toastTimer); if (this.syncTimer) clearInterval(this.syncTimer);
    window.removeEventListener('online', this.onlineHandler); window.removeEventListener('offline', this.offlineHandler);
  }
  get selectedEvent(): EventSummary | undefined { return this.events.find(event => event.eventId === this.selectedEventId); }
  get manualCodeLength(): number { return this.selectedEvent?.ticketCodeLength || 8; }
  get checkedInCount(): number { return this.recentCheckIns.filter(item => item.status === 'SYNCED' && item.outcome === 'ADMITTED').length; }
  get issueCount(): number { return this.recentCheckIns.filter(item => item.status === 'REJECTED' || item.status === 'CONFLICT' || item.status === 'ERROR').length; }
  selectTab(tab: 'scan' | 'manual' | 'history'): void {
    this.activeTab = tab;
    if (tab !== 'scan') this.stopScanner();
    if (tab === 'history') {
      void this.refreshQueueItems();
      void this.loadRecentCheckIns();
    }
  }
  openEventPicker(): void {
    this.stopScanner();
    this.isEventPickerOpen = true;
  }
  selectEvent(event: EventSummary): void {
    if (!event.isLive) return;
    this.selectedEventId = event.eventId;
    void this.offlineQueue.saveSelectedEventId(event.eventId);
    this.recentCheckIns = [];
    this.rosterReady = false;
    this.mssv = '';
    this.activeTab = 'scan';
    this.isEventPickerOpen = false;
    void this.loadRecentCheckIns();
    void this.refreshRosterAvailability();
    void this.syncSelectedEvent();
    this.showToast('Đã chọn ' + event.name + '.', 'info');
  }
  eventStatusLabel(event: EventSummary): string {
    return event.isLive ? 'Đang mở cổng' : 'Đã đóng cổng';
  }
  eventSchedule(event: EventSummary): string {
    if (event.scheduleLabel) return event.scheduleLabel;
    if (!event.eventDate) return event.venue || 'Chưa đặt lịch';
    if (event.allDay) return event.eventDate;
    return [event.eventDate, event.startsAt && event.endsAt ? `${event.startsAt} – ${event.endsAt}` : event.startsAt].filter(Boolean).join(' · ');
  }
  recentIcon(item: RecentCheckIn): string {
    if (item.status === 'QUEUED') return '↥';
    if (item.status === 'ERROR') return '!';
    if (item.status === 'CONFLICT' || item.outcome === 'REJECTED_ALREADY_USED') return '↻';
    if (item.status === 'REJECTED' || item.outcome === 'REJECTED_NOT_FOUND' || item.outcome === 'REJECTED_CANCELLED') return '×';
    if (item.outcome === 'UNDONE') return '↶';
    if (item.status === 'SYNCED' && item.outcome === 'ADMITTED') return '✓';
    return '…';
  }
  recentLabel(item: RecentCheckIn): string {
    if (item.status === 'ERROR') return 'Lỗi đồng bộ; dữ liệu vẫn được giữ trên thiết bị.';
    if (item.status === 'CONFLICT') return 'Trùng: đã điểm danh trước đó.';

    const outcomeLabels: Record<ScanOutcome, string> = {
      ADMITTED: item.status === 'QUEUED' ? 'Đã lưu điểm danh, chờ đồng bộ.' : 'Điểm danh thành công.',
      REJECTED_ALREADY_USED: item.status === 'QUEUED'
        ? 'Trùng: đã điểm danh trước đó; chờ đồng bộ bản ghi.'
        : 'Trùng: đã điểm danh trước đó.',
      REJECTED_NOT_FOUND: item.status === 'QUEUED'
        ? 'Không có trong danh sách điểm danh; chờ đồng bộ bản ghi.'
        : 'Không thể điểm danh: mã không có trong danh sách.',
      REJECTED_CANCELLED: item.status === 'QUEUED'
        ? 'Vé đã bị hủy; chờ đồng bộ bản ghi.'
        : 'Không thể điểm danh: vé đã bị hủy.',
      UNDONE: item.status === 'QUEUED' ? 'Đã lưu hoàn tác, chờ đồng bộ.' : 'Đã hoàn tác điểm danh.',
    };
    return outcomeLabels[item.outcome];
  }
  recentDescription(item: RecentCheckIn): string {
    if (item.status === 'ERROR') return item.message || this.recentLabel(item);
    if (item.status === 'CONFLICT') {
      const detail = item.message?.trim();
      if (!detail || detail === 'Điểm danh thành công.' || detail === 'Đã điểm danh trước đó.') {
        return 'Trùng: đã điểm danh trước đó.';
      }
      return detail.startsWith('Trùng:') ? detail : 'Trùng: ' + detail;
    }
    return this.recentLabel(item);
  }
  get manualDigits(): string[] {
    return Array.from({ length: this.manualCodeLength }, (_, index) => this.mssv[index] ?? '');
  }
  get isManualCodeComplete(): boolean { return this.mssv.length === this.manualCodeLength; }
  pressManualDigit(digit: string): void {
    if (this.isSubmitting || this.isManualCodeComplete) return;
    this.mssv += digit;
    if (this.isManualCodeComplete) setTimeout(() => this.checkIn(), 120);
  }
  removeManualDigit(): void {
    if (!this.isSubmitting) this.mssv = this.mssv.slice(0, -1);
  }
  clearManualDigits(): void {
    if (!this.isSubmitting) this.mssv = '';
  }
  loadEvents(): void {
    if (this.authState !== 'ready') return;
    this.api.getEvents().subscribe({
      next: events => {
        const normalizedEvents = events.map(event => ({ ...event, dedupeEnabled: event.dedupeEnabled !== false }));
        this.events = normalizedEvents;
        if (!normalizedEvents.some(event => event.eventId === this.selectedEventId && event.isLive)) {
          this.selectedEventId = '';
          this.rosterReady = false;
        }
        this.isLoading = false;
        this.usingCachedEvents = false;
        void this.offlineQueue.cacheEvents(normalizedEvents);
        void this.loadRecentCheckIns();
        if (this.selectedEventId) {
          void this.refreshRosterAvailability();
          void this.syncSelectedEvent();
        } else this.isEventPickerOpen = true;
      },
      error: error => {
        if (error instanceof HttpErrorResponse && error.status === 401) {
          this.expireAuthentication();
        } else if (error instanceof HttpErrorResponse && error.status === 403) {
          this.authState = 'pending';
          this.isEventPickerOpen = false;
          this.isLoading = false;
        } else void this.loadCachedEvents(error);
      },
    });
  }

  startLogin(): void {
    this.api.clearAccessToken();
    window.location.assign(this.api.webLoginUrl());
  }

  openAccessCodeLogin(): void {
    this.accessCodeError = '';
    this.showAccessCodeLogin = true;
  }

  closeAccessCodeLogin(): void {
    if (this.isValidatingAccessCode) return;
    this.accessCodeError = '';
    this.showAccessCodeLogin = false;
  }

  async submitAccessCode(): Promise<void> {
    const token = this.accessCode.trim().replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      this.accessCodeError = 'Hãy dán đầy đủ mã dành cho ứng dụng ngoài.';
      return;
    }
    this.isValidatingAccessCode = true;
    this.accessCodeError = '';
    try {
      this.api.saveAccessToken(token);
      const identity = await firstValueFrom(this.api.me());
      this.accessCode = '';
      this.showAccessCodeLogin = false;
      this.acceptIdentity(identity);
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) {
        this.api.clearAccessToken();
        this.accessCodeError = 'Mã không hợp lệ, đã hết hạn hoặc bị dán thiếu.';
      } else {
        this.accessCodeError = this.errorMessage(error as HttpErrorResponse);
      }
    } finally {
      this.isValidatingAccessCode = false;
      this.changeDetector.detectChanges();
    }
  }

  async logout(): Promise<void> {
    this.stopScanner();
    const usedAccessCode = this.api.hasAccessToken;
    this.api.clearAccessToken();
    this.clearCachedIdentity();
    try {
      await firstValueFrom(this.api.logout());
    } catch {
      if (!usedAccessCode) {
        this.showErrorMessage('Không thể đăng xuất. Vui lòng thử lại.');
        return;
      }
    }
    this.resetAuthentication();
  }

  private async loadIdentity(): Promise<void> {
    try {
      await this.offlineQueue.migrateLegacyHistory();
      this.selectedEventId = await this.offlineQueue.selectedEventId();
    } catch { /* Continue without a restored selection. */ }

    try {
      this.acceptIdentity(await firstValueFrom(this.api.me()));
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401 && this.api.hasAccessToken) {
        this.api.clearAccessToken();
        try {
          this.acceptIdentity(await firstValueFrom(this.api.me()));
          return;
        } catch (cookieError) {
          this.handleIdentityFailure(cookieError);
          return;
        }
      }
      this.handleIdentityFailure(error);
    }
  }

  private acceptIdentity(identity: MeResponse): void {
    this.identity = identity;
    this.cacheIdentity(identity);
    this.isLoading = false;
    this.isEventPickerOpen = false;
    if (!identity.role) {
      this.authState = 'pending';
      return;
    }
    this.authState = 'ready';
    this.loadEvents();
  }

  private handleIdentityFailure(error: unknown): void {
    this.isLoading = false;
    this.isEventPickerOpen = false;
    if (error instanceof HttpErrorResponse && error.status === 401) {
      this.api.clearAccessToken();
      this.clearCachedIdentity();
      this.authState = 'login';
      return;
    }
    const cached = this.cachedIdentity();
    if (cached?.role) {
      this.identity = cached;
      this.authState = 'ready';
      this.loadEvents();
      return;
    }
    this.authState = 'login';
  }
  async startScanner(): Promise<void> {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.showErrorMessage('Camera cần HTTPS hoặc http://localhost. Bạn có thể nhập MSSV thủ công khi không thể mở camera.'); return;
    }
    this.stopScanner(); this.isScanning = true;
    setTimeout(() => void this.bindCamera(), 0);
  }
  stopScanner(): void {
    this.isScanning = false;
    if (this.scanModeTimer) clearTimeout(this.scanModeTimer);
    if (this.focusLockTimer) clearTimeout(this.focusLockTimer);
    this.scanModeTimer = undefined;
    this.focusLockTimer = undefined;
    this.scannerReader = undefined;
    this.isFallbackScanMode = false;
    this.scannerControls?.stop();
    this.scannerControls = undefined;
    this.torchAvailable = false;
    this.torchOn = false;
  }
  async toggleTorch(): Promise<void> {
    if (!this.scannerControls?.switchTorch) return;
    try {
      this.torchOn = !this.torchOn;
      await this.scannerControls.switchTorch(this.torchOn);
    } catch {
      this.torchOn = false;
      this.showErrorMessage('Không thể bật đèn camera trên thiết bị này.');
    }
  }
  checkIn(ticketCode = this.mssv, scanned = false): void {
    const normalizedCode = ticketCode.trim().replace(/\s+/g, '').toUpperCase();
    const event = this.selectedEvent;
    if (!event || !normalizedCode || (!scanned && this.isSubmitting)) return;
    if (!/^[A-Z0-9_-]{1,64}$/.test(normalizedCode)) {
      this.showErrorMessage('Mã vé chỉ gồm chữ, số, gạch ngang hoặc gạch dưới.');
      return;
    }
    const scanKey = this.scanKey(event.eventId, normalizedCode);
    if (scanned && !this.acceptScannedCode(scanKey)) return;
    this.isSubmitting = !scanned;
    this.mssv = '';
    void this.recordScan(event, normalizedCode, scanned ? this.method : 'MANUAL', scanned);
  }

  async retryPendingCheckIns(): Promise<void> {
    await this.offlineQueue.retryFailed();
    await this.refreshQueueSummary();
    await this.refreshConnectivity(true);
  }

  private async recordScan(event: EventSummary, ticketCode: string, entryMode: ScanEntryMode, scanned: boolean): Promise<void> {
    const scanKey = this.scanKey(event.eventId, ticketCode);
    try {
      if (!event.gateId) {
        this.showErrorMessage('Sự kiện chưa có cổng soát vé để ghi nhận lượt quét.');
        return;
      }
      const ticket = await this.offlineQueue.getTicket(event.eventId, ticketCode);
      const dedupeEnabled = event.dedupeEnabled !== false;
      const pending = dedupeEnabled && await this.offlineQueue.pendingTicket(event.eventId, ticketCode);
      if (pending) {
        this.showToast(this.attendanceToastMessage('REJECTED_ALREADY_USED', ticket?.holderName || ticketCode), 'duplicate');
        return;
      }
      const outcome = this.outcomeFor(event, ticket, pending);
      const scan: ScanRequest = {
        clientEventId: crypto.randomUUID(),
        eventId: event.eventId,
        gateId: event.gateId,
        ticketCode,
        outcome,
        undoesEventId: null,
        scannedAtWallClock: Date.now(),
        deviceSeq: await this.offlineQueue.nextDeviceSequence(),
        deviceId: await this.offlineQueue.deviceIdentity(),
        entryMode,
      };
      const enqueued = await this.offlineQueue.enqueue(scan, ticket?.holderName, !dedupeEnabled);
      if (!enqueued) {
        this.showToast(this.attendanceToastMessage('REJECTED_ALREADY_USED', ticket?.holderName || ticketCode), 'duplicate');
        return;
      }
      await this.loadRecentCheckIns();
      this.showToast(
        this.attendanceToastMessage(outcome, ticket?.holderName || ticketCode),
        this.toastKindForOutcome(outcome),
      );
      if (this.networkStatus === 'ONLINE') await this.pushQueuedScans(event.eventId);
    } catch (error) {
      this.showErrorMessage('Không thể lưu lượt quét trên thiết bị.');
    } finally {
      this.isSubmitting = false;
      if (scanned) {
        this.activeScanKeys.delete(scanKey);
        this.scanCooldowns.set(scanKey, Date.now());
      }
      await this.refreshQueueSummary();
      await this.refreshQueueItems();
      this.changeDetector.detectChanges();
    }
  }

  get toastIcon(): string {
    const icons: Record<ToastKind, string> = { success: '✓', duplicate: '↻', rejected: '×', info: 'i', error: '!' };
    return icons[this.toastKind];
  }

  private toastKindForOutcome(outcome: ScanOutcome): ToastKind {
    if (outcome === 'ADMITTED') return 'success';
    if (outcome === 'REJECTED_ALREADY_USED') return 'duplicate';
    if (outcome === 'REJECTED_NOT_FOUND' || outcome === 'REJECTED_CANCELLED') return 'rejected';
    return 'info';
  }

  private attendanceToastMessage(outcome: ScanOutcome, attendee: string): string {
    switch (outcome) {
      case 'ADMITTED': return attendee + ': đã điểm danh.';
      case 'REJECTED_ALREADY_USED': return attendee + ': đã điểm danh trước đó.';
      case 'REJECTED_NOT_FOUND': return attendee + ': không có trong danh sách điểm danh.';
      case 'REJECTED_CANCELLED': return attendee + ': không thể điểm danh.';
      default: return attendee + ': trạng thái điểm danh đã được cập nhật.';
    }
  }

  private outcomeFor(event: EventSummary, ticket: Ticket | undefined, hasPendingScan: boolean): ScanOutcome {
    if (!ticket) return 'REJECTED_NOT_FOUND';
    if (ticket.status === 'CANCELLED') return 'REJECTED_CANCELLED';
    if ((ticket.status === 'USED' || hasPendingScan) && event.dedupeEnabled !== false) return 'REJECTED_ALREADY_USED';
    return 'ADMITTED';
  }

  private async syncSelectedEvent(): Promise<void> {
    const event = this.selectedEvent;
    if (!event || this.networkStatus !== 'ONLINE') return;
    try {
      await this.syncRoster(event);
      await this.pushQueuedScans(event.eventId);
      await this.syncScanFeed(event);
      await this.loadRecentCheckIns();
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) {
        this.expireAuthentication();
        this.showErrorMessage('Phiên đăng nhập đã hết hạn. Dữ liệu vẫn được giữ trên thiết bị.');
      } else if (this.shouldRetry(error)) {
        this.setNetworkStatus('OFFLINE');
      }
    }
  }

  private async syncRoster(event: EventSummary): Promise<void> {
    const state = await this.offlineQueue.getSyncState(event.eventId);
    if (state.rosterVersion === event.rosterVersion && await this.offlineQueue.hasRoster(event.eventId)) return;
    let cursor = '0';
    let version = state.rosterVersion;
    let firstPage = true;
    do {
      const page = await firstValueFrom(this.api.getRoster(event.eventId, cursor, state.rosterVersion));
      if (firstPage) {
        version = page.version;
        firstPage = false;
      }
      await this.offlineQueue.applyRosterPage(event.eventId, page.tickets);
      cursor = page.nextCursor ?? '';
    } while (cursor);
    await this.offlineQueue.saveRosterVersion(event.eventId, version);
    await this.refreshRosterAvailability();
  }

  private async syncScanFeed(event: EventSummary): Promise<void> {
    let since = (await this.offlineQueue.getSyncState(event.eventId)).scansSince;
    while (true) {
      const feed = await firstValueFrom(this.api.getScans(event.eventId, since));
      for (const scan of feed.scans) await this.applyServerScan(event.eventId, scan);
      since = feed.nextSince;
      if (!feed.scans.length) break;
    }
    await this.offlineQueue.saveScansSince(event.eventId, since);
  }

  private async applyServerScan(eventId: string, scan: ScanRecord): Promise<void> {
    if (await this.offlineQueue.pendingTicket(eventId, scan.ticketCode)) return;
    const ticket = await this.offlineQueue.getTicket(eventId, scan.ticketCode);
    if (!ticket || !scan.accepted) return;
    const status = scan.outcome === 'ADMITTED' ? 'USED' : scan.outcome === 'UNDONE' ? 'VALID' : ticket.status;
    await this.offlineQueue.applyRosterPage(eventId, [{ ...ticket, status, checkedInAt: scan.scannedAtWallClock, checkedInAtGate: scan.gateName ?? null }]);
  }

  private async pushQueuedScans(eventId: string): Promise<void> {
    if (this.isSyncing || this.networkStatus !== 'ONLINE') return;
    this.isSyncing = true;
    let batchSize = 500;
    try {
      while (true) {
        const queued = await this.offlineQueue.pendingForEvent(eventId, batchSize);
        if (!queued.length) break;
        try {
          const { acks } = await firstValueFrom(this.api.postScans(queued.map(item => item.payload)));
          const queuedById = new Map(queued.map(item => [item.clientEventId, item]));
          const acknowledged = acks.filter(ack => queuedById.has(ack.clientEventId));
          if (!acknowledged.length) {
            await this.offlineQueue.markAttempt(
              queued.map(item => item.clientEventId),
              'Server chưa xác nhận lượt quét; dữ liệu sẽ được gửi lại.',
            );
            break;
          }

          await this.offlineQueue.acknowledge(acknowledged.map(ack => ack.clientEventId));
          for (const ack of acknowledged) {
            const queuedItem = queuedById.get(ack.clientEventId)!;
            await this.offlineQueue.updateHistory(
              ack.clientEventId,
              this.resolvedHistoryStatus(queuedItem.payload.outcome, ack.accepted, ack.conflictReason),
            );
          }

          if (acknowledged.length < queued.length) {
            const acknowledgedIds = new Set(acknowledged.map(ack => ack.clientEventId));
            const missingIds = queued
              .filter(item => !acknowledgedIds.has(item.clientEventId))
              .map(item => item.clientEventId);
            await this.offlineQueue.markAttempt(missingIds, 'Server chưa xác nhận lượt quét; dữ liệu sẽ được gửi lại.');
            break;
          }
          batchSize = 500;
        } catch (error) {
          const httpError = error as HttpErrorResponse;
          const message = this.errorMessage(httpError);
          const ids = queued.map(item => item.clientEventId);

          if (httpError.status === 413 && queued.length > 1) {
            batchSize = Math.max(1, Math.floor(queued.length / 2));
            continue;
          }

          const problemIndexes: number[] = httpError.status === 400 && Array.isArray(httpError.error?.problems)
            ? httpError.error.problems
                .map((problem: { index: number }) => problem.index)
                .filter((index: number) => Number.isInteger(index) && index >= 0 && index < queued.length)
            : [];
          if (problemIndexes.length) {
            const invalidItems: QueuedScan[] = problemIndexes.map((index: number) => queued[index]);
            const invalidIds: string[] = invalidItems.map((item: QueuedScan) => item.clientEventId);
            await this.offlineQueue.markAttempt(invalidIds, message);
            await this.offlineQueue.markFailed(invalidIds, message);
            for (const item of invalidItems) {
              await this.offlineQueue.updateHistory(item.clientEventId, { status: 'ERROR', message });
            }
            if (invalidIds.length < queued.length) continue;
            break;
          }

          await this.offlineQueue.markAttempt(ids, message);
          if (!this.shouldRetry(httpError) && httpError.status !== 401) {
            await this.offlineQueue.markFailed(ids, message);
            for (const item of queued) {
              await this.offlineQueue.updateHistory(item.clientEventId, { status: 'ERROR', message });
            }
          }
          if (httpError.status === 401) {
            this.expireAuthentication();
            this.showErrorMessage('Phiên đăng nhập đã hết hạn. Dữ liệu vẫn được giữ trên thiết bị.');
          }
          break;
        }
      }
    } finally {
      this.isSyncing = false;
      await this.refreshQueueSummary();
      await this.refreshQueueItems();
    }
  }

  private resolvedHistoryStatus(
    outcome: ScanOutcome,
    accepted: boolean,
    conflictReason?: string | null,
  ): Pick<ScanHistoryItem, 'status' | 'message'> {
    if (!accepted) {
      const reason = conflictReason?.trim();
      return { status: 'CONFLICT', message: reason ? 'Trùng: ' + reason : 'Trùng: cổng khác đã điểm danh trước.' };
    }
    if (outcome === 'REJECTED_ALREADY_USED') {
      return { status: 'CONFLICT', message: 'Trùng: đã điểm danh trước đó.' };
    }
    if (outcome === 'REJECTED_NOT_FOUND') {
      return { status: 'REJECTED', message: 'Không thể điểm danh: mã không có trong danh sách.' };
    }
    if (outcome === 'REJECTED_CANCELLED') {
      return { status: 'REJECTED', message: 'Không thể điểm danh: vé đã bị hủy.' };
    }
    if (outcome === 'UNDONE') {
      return { status: 'SYNCED', message: 'Đã hoàn tác điểm danh.' };
    }
    return { status: 'SYNCED', message: 'Điểm danh thành công.' };
  }

  private acceptScannedCode(scanKey: string): boolean {
    const now = Date.now();
    const lastAcceptedAt = this.scanCooldowns.get(scanKey) ?? 0;
    if (this.activeScanKeys.has(scanKey) || now - lastAcceptedAt < this.scanCooldownMs) return false;
    this.activeScanKeys.add(scanKey);
    this.scanCooldowns.set(scanKey, now);
    for (const [key, acceptedAt] of this.scanCooldowns) {
      if (now - acceptedAt > 30000) this.scanCooldowns.delete(key);
    }
    return true;
  }

  private async loadRecentCheckIns(): Promise<void> {
    const eventId = this.selectedEventId;
    const savedHistory = eventId
      ? await this.offlineQueue.historyForEvent(eventId)
      : await this.offlineQueue.allHistory();
    if (eventId !== this.selectedEventId) return;
    this.recentCheckIns = savedHistory;
    this.changeDetector.detectChanges();
  }

  private async refreshRosterAvailability(): Promise<void> {
    const eventId = this.selectedEventId;
    this.rosterReady = !!eventId && await this.offlineQueue.hasRoster(eventId);
    this.changeDetector.detectChanges();
  }

  private async loadCachedEvents(error: HttpErrorResponse): Promise<void> {
    const cached = await this.offlineQueue.cachedEvents();
    if (cached?.events.length) {
      this.events = cached.events;
      if (!cached.events.some(event => event.eventId === this.selectedEventId)) {
        this.selectedEventId = '';
        this.rosterReady = false;
      }
      this.isLoading = false;
      this.usingCachedEvents = true;
      void this.loadRecentCheckIns();
      if (this.selectedEventId) void this.refreshRosterAvailability();
      else this.isEventPickerOpen = true;
      if (this.selectedEventId) {
        this.showToast('Đang dùng danh sách sự kiện đã lưu trên thiết bị.', 'info');
        return;
      }
    }
    this.showError(error);
  }

  private async refreshQueueSummary(): Promise<void> {
    const summary = await this.offlineQueue.summary();
    this.pendingCount = summary.pending;
    this.failedCount = summary.failed;
    this.pendingRequestCount = summary.pending;
    this.changeDetector.detectChanges();
  }

  private async refreshQueueItems(): Promise<void> { this.queueItems = await this.offlineQueue.all(); }

  private shouldRetry(error: unknown): boolean {
    if (!(error instanceof HttpErrorResponse)) return true;
    return error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500;
  }

  get networkStatusLabel(): string {
    if (this.networkStatus === 'ONLINE') return 'Hệ thống sẵn sàng đồng bộ';
    if (this.networkStatus === 'CHECKING') return 'Đang kiểm tra kết nối hệ thống';
    return 'Chưa thể kết nối đến hệ thống';
  }

  private async refreshConnectivity(syncAfterSuccess: boolean): Promise<void> {
    if (!navigator.onLine) {
      this.setNetworkStatus('OFFLINE');
      return;
    }
    if (this.isCheckingConnectivity) return;
    this.isCheckingConnectivity = true;
    this.setNetworkStatus('CHECKING');
    try {
      await firstValueFrom(this.api.health());
      this.setNetworkStatus('ONLINE');
      if (syncAfterSuccess) {
        await this.syncSelectedEvent();
        for (const eventId of await this.offlineQueue.queuedEvents()) {
          if (eventId !== this.selectedEventId) await this.pushQueuedScans(eventId);
        }
      }
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) {
        this.expireAuthentication();
      } else {
        this.setNetworkStatus('OFFLINE');
      }
    } finally {
      this.isCheckingConnectivity = false;
    }
  }

  private setNetworkStatus(status: 'CHECKING' | 'ONLINE' | 'OFFLINE'): void {
    this.networkStatus = status;
    this.changeDetector.detectChanges();
  }

  private async requestPersistentStorage(): Promise<void> {
    try { await navigator.storage?.persist(); } catch { /* Browser storage is still usable without persistence. */ }
  }

  private cacheIdentity(identity: MeResponse): void {
    try { localStorage.setItem(this.identityCacheKey, JSON.stringify(identity)); } catch { /* Optional cache. */ }
  }

  private cachedIdentity(): MeResponse | undefined {
    try {
      const value = localStorage.getItem(this.identityCacheKey);
      return value ? JSON.parse(value) as MeResponse : undefined;
    } catch {
      return undefined;
    }
  }

  private clearCachedIdentity(): void {
    try { localStorage.removeItem(this.identityCacheKey); } catch { /* Optional cache. */ }
  }

  private expireAuthentication(): void {
    this.api.clearAccessToken();
    this.clearCachedIdentity();
    this.resetAuthentication();
  }

  private resetAuthentication(): void {
    this.identity = undefined;
    this.authState = 'login';
    this.events = [];
    this.selectedEventId = '';
    this.isLoading = false;
    this.isEventPickerOpen = false;
    this.showAccessCodeLogin = false;
    this.accessCode = '';
  }

  formatCheckedInAt(value: number): string { return new Date(value).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'medium' }); }
  private async bindCamera(): Promise<void> {
    try {
      const video = this.scannerVideo?.nativeElement; if (!video || !this.isScanning) return;
      const reader = new BrowserMultiFormatReader(this.scannerHints(this.priorityScanFormats), { delayBetweenScanAttempts: 70, delayBetweenScanSuccess: 60 });
      this.scannerReader = reader;
      const cameraConstraints: MediaTrackConstraints = {
        facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 },
        focusMode: { ideal: 'continuous' }, exposureMode: { ideal: 'continuous' }, whiteBalanceMode: { ideal: 'continuous' },
      } as MediaTrackConstraints;
      const controls = await reader.decodeFromConstraints({ video: cameraConstraints, audio: false }, video, result => this.handleDecodedResult(reader, result));
      if (this.isScanning && this.scannerReader === reader) {
        this.scannerControls = controls;
        this.torchAvailable = !!controls.switchTorch;
        this.scheduleFormatFallback(reader);
        this.scheduleFocusLock(video);
      } else controls.stop();
    } catch { this.stopScanner(); this.showErrorMessage('Không thể mở camera. Hãy kiểm tra quyền truy cập camera.'); }
  }
  private scannerHints(formats: BarcodeFormat[], tryHarder = false): Map<DecodeHintType, unknown> {
    const hints = new Map<DecodeHintType, unknown>([[DecodeHintType.POSSIBLE_FORMATS, formats]]);
    if (tryHarder) hints.set(DecodeHintType.TRY_HARDER, true);
    return hints;
  }

  private handleDecodedResult(reader: BrowserMultiFormatReader, result?: Result): void {
    if (!result) return;
    const isPriorityFormat = this.priorityScanFormats.includes(result.getBarcodeFormat());
    if (isPriorityFormat) {
      if (this.isFallbackScanMode) reader.setHints(this.scannerHints(this.priorityScanFormats));
      this.isFallbackScanMode = false;
      this.scheduleFormatFallback(reader);
    } else if (this.isFallbackScanMode) {
      this.schedulePriorityScanMode(reader);
    }
    this.handleScan(result);
  }

  private scheduleFormatFallback(reader: BrowserMultiFormatReader): void {
    if (this.scanModeTimer) clearTimeout(this.scanModeTimer);
    this.scanModeTimer = setTimeout(() => {
      if (!this.isScanning || this.scannerReader !== reader || this.isFallbackScanMode) return;
      reader.setHints(this.scannerHints(this.fallbackScanFormats, true));
      this.isFallbackScanMode = true;
      this.schedulePriorityScanMode(reader);
    }, this.priorityScanWindowMs);
  }

  private schedulePriorityScanMode(reader: BrowserMultiFormatReader): void {
    if (this.scanModeTimer) clearTimeout(this.scanModeTimer);
    this.scanModeTimer = setTimeout(() => {
      if (!this.isScanning || this.scannerReader !== reader || !this.isFallbackScanMode) return;
      reader.setHints(this.scannerHints(this.priorityScanFormats));
      this.isFallbackScanMode = false;
      this.scheduleFormatFallback(reader);
    }, this.fallbackQuietMs);
  }

  private scheduleFocusLock(video: HTMLVideoElement): void {
    if (this.focusLockTimer) clearTimeout(this.focusLockTimer);
    this.focusLockTimer = setTimeout(() => void this.lockFocusAndCompensateExposure(video), 350);
  }

  private async lockFocusAndCompensateExposure(video: HTMLVideoElement): Promise<void> {
    const track = (video.srcObject as MediaStream | null)?.getVideoTracks()[0];
    if (!track || !this.isScanning) return;
    const compatibleTrack = track as MediaStreamTrack & { getCapabilities?: () => ScannerTrackCapabilities };
    const capabilities = compatibleTrack.getCapabilities?.() as ScannerTrackCapabilities | undefined;
    if (!capabilities) return;
    const exposure = capabilities.exposureCompensation;
    const exposureMinimum = exposure?.min;
    const exposureMaximum = exposure?.max;
    if (typeof exposureMinimum === 'number' && typeof exposureMaximum === 'number' && exposureMaximum > 0) {
      try {
        const exposureStep = exposure?.step;
        const requested = Math.min(exposureMaximum, Math.max(exposureMinimum, 0.7));
        const compensation = typeof exposureStep === 'number' && exposureStep > 0
          ? exposureMinimum + Math.round((requested - exposureMinimum) / exposureStep) * exposureStep
          : requested;
        await track.applyConstraints({ advanced: [{ exposureCompensation: compensation }] } as unknown as MediaTrackConstraints);
      } catch { /* The camera may not allow exposure compensation. */ }
    }
    try {
      const settings = track.getSettings() as MediaTrackSettings & ScannerTrackSettings;
      if (capabilities.focusMode?.includes('manual') && Number.isFinite(settings.focusDistance)) {
        await track.applyConstraints({ advanced: [{ focusMode: 'manual', focusDistance: settings.focusDistance! }] } as unknown as MediaTrackConstraints);
      }
    } catch {
      // Unsupported focus controls must not stop the active scanner.
    }
  }

  private handleScan(result?: Result): void {
    if (!result || !this.isScanning) return;
    const mssv = result.getText().trim();
    if (!mssv) return;
    this.method = 'AUTO_SCAN';
    this.zone.run(() => this.checkIn(mssv, true));
  }
  private scanKey(eventId: string, mssv: string): string { return eventId + '\u0000' + mssv; }
  private showError(error: HttpErrorResponse): void {
    this.showErrorMessage(this.errorMessage(error));
    this.isLoading = false;
  }
  private errorMessage(error: HttpErrorResponse): string {
    const messages: Record<string, string> = {
      missing_token: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
      invalid_token: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
      no_group: 'Tài khoản đang chờ được cấp quyền.',
      disabled: 'Tài khoản đã bị khoá.',
      forbidden: 'Bạn không có quyền thực hiện thao tác này.',
      event_not_found: 'Không tìm thấy sự kiện.',
      bad_scan: 'Dữ liệu lượt quét không hợp lệ.',
      batch_too_large: 'Lô quét quá lớn, hệ thống sẽ tự chia lô nhỏ hơn.',
    };
    return messages[error.error?.error] || error.error?.message || 'Không thể kết nối đến hệ thống điểm danh. Vui lòng thử lại.';
  }
  private showErrorMessage(message: string): void { this.showToast(message, 'error'); }
  private showToast(message: string, kind: ToastKind): void {
    this.toastMessage = message;
    this.toastKind = kind;
    this.changeDetector.detectChanges();
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastMessage = '';
      this.toastKind = 'info';
      this.changeDetector.detectChanges();
    }, 2000);
  }
}
