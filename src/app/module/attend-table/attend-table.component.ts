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
        this.events = events;
        if (!events.some(event => event.eventId === this.selectedEventId && event.isLive)) {
          this.selectedEventId = '';
          this.rosterReady = false;
        }
        this.isLoading = false;
        this.usingCachedEvents = false;
        void this.offlineQueue.cacheEvents(events);
        void this.loadRecentCheckIns();
        if (this.selectedEventId) {
          void this.refreshRosterAvailability();
          void this.syncSelectedEvent();
        } else this.isEventPickerOpen = true;
      },
      error: error => {
        if (error instanceof HttpErrorResponse && (error.status === 401 || error.status === 403)) {
          this.authState = error.status === 401 ? 'login' : 'pending';
          this.isEventPickerOpen = false;
          this.isLoading = false;
        }
        else void this.loadCachedEvents(error);
      },
    });
  }

  startLogin(): void { window.location.assign(this.api.webLoginUrl()); }

  async logout(): Promise<void> {
    this.stopScanner();
    try {
      await firstValueFrom(this.api.logout());
      this.identity = undefined;
      this.authState = 'login';
      this.events = [];
      this.selectedEventId = '';
      this.isEventPickerOpen = false;
    } catch {
      this.showErrorMessage('Không thể đăng xuất. Vui lòng thử lại.');
    }
  }

  private async loadIdentity(): Promise<void> {
    try {
      await this.offlineQueue.migrateLegacyHistory();
      this.selectedEventId = await this.offlineQueue.selectedEventId();
    } catch { /* Continue without a restored selection. */ }
    try {
      this.identity = await firstValueFrom(this.api.me());
      if (!this.identity.role) {
        this.authState = 'pending';
        this.isLoading = false;
        this.isEventPickerOpen = false;
        return;
      }
      this.authState = 'ready';
      this.loadEvents();
    } catch (error) {
      this.isLoading = false;
      this.authState = error instanceof HttpErrorResponse && error.status === 401 ? 'login' : 'pending';
      this.isEventPickerOpen = false;
    }
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
      const pending = await this.offlineQueue.pendingTicket(event.eventId, ticketCode);
      if (pending) {
        this.showToast(this.attendanceToastMessage('REJECTED_ALREADY_USED', ticket?.holderName || ticketCode), 'duplicate');
        return;
      }
      const outcome = this.outcomeFor(ticket, pending);
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
      const enqueued = await this.offlineQueue.enqueue(scan, ticket?.holderName);
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

  private outcomeFor(ticket: Ticket | undefined, hasPendingScan: boolean): ScanOutcome {
    if (!ticket) return 'REJECTED_NOT_FOUND';
    if (ticket.status === 'CANCELLED') return 'REJECTED_CANCELLED';
    if (ticket.status === 'USED' || hasPendingScan) return 'REJECTED_ALREADY_USED';
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
      if (this.shouldRetry(error)) this.setNetworkStatus('OFFLINE');
    }
  }

  private async syncRoster(event: EventSummary): Promise<void> {
    const state = await this.offlineQueue.getSyncState(event.eventId);
    if (state.rosterVersion === event.rosterVersion) return;
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
    try {
      while (true) {
        const queued = await this.offlineQueue.pendingForEvent(eventId);
        if (!queued.length) break;
        try {
          const { acks } = await firstValueFrom(this.api.postScans(queued.map(item => item.payload)));
          if (!acks.length) break;
          await this.offlineQueue.acknowledge(acks.map(ack => ack.clientEventId));
          for (const ack of acks) {
            const queuedItem = queued.find(item => item.clientEventId === ack.clientEventId);
            if (!queuedItem) continue;
            await this.offlineQueue.updateHistory(
              ack.clientEventId,
              this.resolvedHistoryStatus(queuedItem.payload.outcome, ack.accepted, ack.conflictReason, ack.duplicate),
            );
          }
        } catch (error) {
          const message = this.errorMessage(error as HttpErrorResponse);
          const ids = queued.map(item => item.clientEventId);
          await this.offlineQueue.markAttempt(ids, message);
          if (!this.shouldRetry(error) && !(error instanceof HttpErrorResponse && error.status === 401)) {
            await this.offlineQueue.markFailed(ids, message);
            for (const item of queued) await this.offlineQueue.updateHistory(item.clientEventId, { status: 'ERROR', message });
          }
          if (error instanceof HttpErrorResponse && error.status === 401) {
            this.authState = 'login';
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
    duplicate = false,
  ): Pick<ScanHistoryItem, 'status' | 'message'> {
    if (outcome === 'REJECTED_ALREADY_USED' || duplicate) {
      const reason = conflictReason?.trim();
      return { status: 'CONFLICT', message: reason ? 'Trùng: ' + reason : 'Trùng: đã điểm danh trước đó.' };
    }
    if (outcome === 'REJECTED_NOT_FOUND') {
      return { status: 'REJECTED', message: 'Không thể điểm danh: mã không có trong danh sách.' };
    }
    if (outcome === 'REJECTED_CANCELLED') {
      return { status: 'REJECTED', message: 'Không thể điểm danh: vé đã bị hủy.' };
    }
    if (!accepted) {
      const reason = conflictReason?.trim();
      return { status: 'REJECTED', message: reason ? 'Không thể điểm danh: ' + reason : 'Không thể điểm danh: server từ chối lượt quét.' };
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
    } catch {
      this.setNetworkStatus('OFFLINE');
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
