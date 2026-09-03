import { ChangeDetectorRef, Component, ElementRef, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { BrowserMultiFormatReader, IScannerControls } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType, Result } from '@zxing/library';
import { firstValueFrom } from 'rxjs';
import { CheckInMethod, CheckInResult, EventSummary, HttpService } from '../../services/http.service';
import { CheckInHistoryItem, DuplicateQueuedCheckInError, OfflineCheckInQueueService, QueuedCheckIn } from '../../services/offline-check-in-queue.service';

interface PendingCheckIn {
  eventId: string;
  mssv: string;
  method: CheckInMethod;
  requestId: string;
  scanned: boolean;
}

interface ScannerTrackCapabilities {
  focusMode?: string[];
  exposureCompensation?: { min: number; max: number; step?: number };
}

interface ScannerTrackSettings {
  focusDistance?: number;
}

type RecentCheckIn = CheckInHistoryItem;
@Component({ selector: 'app-attend-table', templateUrl: './scanner-shell.component.html', styleUrls: ['./scanner.component.scss'] })


export class AttendTableComponent implements OnInit, OnDestroy {
  @ViewChild('scannerVideo') scannerVideo?: ElementRef<HTMLVideoElement>;
  events: EventSummary[] = []; selectedEventId = ''; mssv = ''; method: CheckInMethod = 'MANUAL';
  readonly manualCodeLength = 8;
  readonly keypadDigits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
  activeTab: 'scan' | 'manual' | 'history' = 'scan';
  isEventPickerOpen = false;
  isLoading = true; isScanning = false; isSubmitting = false; isError = false; torchAvailable = false; torchOn = false; toastMessage = ''; toastIsError = false; resultDialog?: CheckInResult;
  pendingCount = 0; failedCount = 0; pendingRequestCount = 0; isSyncing = false; usingCachedEvents = false;
  isQueueModalOpen = false; queueItems: QueuedCheckIn[] = [];
  recentCheckIns: RecentCheckIn[] = [];
  networkStatus: 'CHECKING' | 'ONLINE' | 'OFFLINE' = navigator.onLine ? 'CHECKING' : 'OFFLINE';
  private scannerControls?: IScannerControls; private toastTimer?: ReturnType<typeof setTimeout>; private syncTimer?: ReturnType<typeof setInterval>; private isCheckingConnectivity = false;
  private activeRequestCount = 0;
  private readonly pendingCheckIns: PendingCheckIn[] = [];
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
  private historySaveChain = Promise.resolve();
  private readonly maxConcurrentRequests = 2;
  private readonly scanCooldownMs = 2500;
  private readonly onlineHandler = () => { void this.refreshConnectivity(true); };
  private readonly offlineHandler = () => { this.setNetworkStatus('OFFLINE'); };
  constructor(private readonly api: HttpService, private readonly offlineQueue: OfflineCheckInQueueService, private readonly zone: NgZone, private readonly changeDetector: ChangeDetectorRef) { }
  ngOnInit(): void {
    void this.prepareQueue();
    void this.requestPersistentStorage();
    window.addEventListener('online', this.onlineHandler); window.addEventListener('offline', this.offlineHandler);
    this.syncTimer = setInterval(() => void this.refreshConnectivity(true), 15000);
    this.loadEvents(); void this.refreshConnectivity(true);
  }
  ngOnDestroy(): void {
    this.stopScanner(); if (this.toastTimer) clearTimeout(this.toastTimer); if (this.syncTimer) clearInterval(this.syncTimer);
    window.removeEventListener('online', this.onlineHandler); window.removeEventListener('offline', this.offlineHandler);
  }
  get selectedEvent(): EventSummary | undefined { return this.events.find(event => event.eventId === this.selectedEventId); }
  get checkedInCount(): number { return this.recentCheckIns.filter(item => item.status === 'CHECKED_IN').length; }
  get issueCount(): number { return this.recentCheckIns.filter(item => item.status === 'ALREADY_CHECKED_IN' || item.status === 'ERROR').length; }
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
    if (event.status !== 'OPEN') return;
    this.selectedEventId = event.eventId;
    this.recentCheckIns = [];
    this.isEventPickerOpen = false;
    void this.loadRecentCheckIns();
    this.showToast('Đã chọn ' + event.name + '.', false);
  }
  eventStatusLabel(event: EventSummary): string {
    const labels: Record<EventSummary['status'], string> = {
      OPEN: 'Đang mở', DRAFT: 'Bản nháp', CLOSED: 'Đã đóng', CANCELLED: 'Đã huỷ',
    };
    return labels[event.status];
  }
  eventSchedule(event: EventSummary): string {
    const start = new Date(event.checkInStartAt);
    const end = new Date(event.checkInEndAt);
    if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())) return 'Chưa đặt thời gian điểm danh';
    return start.toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) + ' – ' + end.toLocaleTimeString('vi-VN', { timeStyle: 'short' });
  }
  recentIcon(item: RecentCheckIn): string {
    if (item.status === 'CHECKED_IN') return '✓';
    if (item.status === 'ALREADY_CHECKED_IN') return '↻';
    if (item.status === 'ERROR') return '!';
    if (item.status === 'QUEUED') return '↥';
    return '…';
  }
  recentLabel(item: RecentCheckIn): string {
    const labels: Record<RecentCheckIn['status'], string> = {
      SENDING: 'Đang gửi', QUEUED: 'Chờ đồng bộ', CHECKED_IN: 'Đã điểm danh',
      ALREADY_CHECKED_IN: 'Đã điểm danh trước đó', ERROR: 'Cần kiểm tra',
    };
    return labels[item.status];
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
    this.api.getEvents().subscribe({
      next: events => {
        this.events = events;
        this.selectedEventId = events.find(event => event.status === 'OPEN')?.eventId ?? '';
        this.isLoading = false;
        this.usingCachedEvents = false;
        void this.offlineQueue.cacheEvents(events);
        void this.loadRecentCheckIns();
        if (!this.selectedEventId) {
          this.showErrorMessage('Hiện không có sự kiện đang mở để điểm danh.');
          return;
        }
      },
      error: error => void this.loadCachedEvents(error),
    });
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
  checkIn(mssv = this.mssv, scanned = false): void {
    const normalizedMssv = mssv.trim().replace(/\s+/g, '').toUpperCase();
    const eventId = this.selectedEventId;
    if (!eventId || !normalizedMssv || (!scanned && this.isSubmitting)) return;
    if (!scanned && !/^\d{8}$/.test(normalizedMssv)) {
      this.showErrorMessage('MSSV nhập tay cần đúng 8 chữ số.');
      return;
    }
    if (scanned && !/^[A-Z0-9]{4,32}$/.test(normalizedMssv)) {
      this.showErrorMessage('Mã quét không hợp lệ. Vui lòng quét đúng mã sinh viên.');
      return;
    }
    if (!scanned) this.method = 'MANUAL';
    const method = this.method;
    const scanKey = this.scanKey(eventId, normalizedMssv);
    if (scanned && !this.acceptScannedCode(scanKey)) return;

    const checkIn: PendingCheckIn = {
      eventId, mssv: normalizedMssv, method, scanned, requestId: crypto.randomUUID(),
    };
    this.addRecentCheckIn(checkIn);
    if (!scanned) {
      this.isSubmitting = true;
      this.mssv = '';
    }

    if (navigator.onLine && this.networkStatus !== 'OFFLINE') {
      this.pendingCheckIns.push(checkIn);
      this.updatePendingRequestCount();
      this.drainCheckInRequests();
      return;
    }
    void this.queueAndSubmit(checkIn).finally(() => this.finishCheckIn(checkIn));
  }

  async retryPendingCheckIns(): Promise<void> {
    await this.offlineQueue.retryFailed();
    await this.refreshQueueSummary();
    await this.refreshConnectivity(true);
    await this.refreshQueueItems();
  }

  async openQueueModal(): Promise<void> {
    await this.refreshQueueItems();
    this.isQueueModalOpen = true;
  }

  closeQueueModal(): void { this.isQueueModalOpen = false; }

  private drainCheckInRequests(): void {
    while (this.activeRequestCount < this.maxConcurrentRequests && this.pendingCheckIns.length) {
      const checkIn = this.pendingCheckIns.shift();
      if (!checkIn) break;
      this.activeRequestCount += 1;
      this.updatePendingRequestCount();
      const process = this.networkStatus === 'OFFLINE'
        ? this.queueAndSubmit(checkIn)
        : this.submitOnlineCheckIn(checkIn);
      void process.finally(() => {
        this.activeRequestCount -= 1;
        this.finishCheckIn(checkIn);
        this.updatePendingRequestCount();
        this.drainCheckInRequests();
      });
    }
    this.updatePendingRequestCount();
  }

  private async submitOnlineCheckIn(checkIn: PendingCheckIn): Promise<void> {
    try {
      const result = await firstValueFrom(this.api.checkIn(checkIn.eventId, checkIn.mssv, checkIn.method, checkIn.requestId));
      this.isError = false;
      this.updateRecentCheckIn(checkIn.requestId, {
        status: result.status === 'CHECKED_IN' ? 'CHECKED_IN' : 'ALREADY_CHECKED_IN',
        fullName: result.fullName,
        message: result.status === 'CHECKED_IN' ? 'Điểm danh thành công.' : 'Sinh viên đã điểm danh trước đó.',
      });
      this.showToast(
        result.status === 'CHECKED_IN'
          ? (result.fullName || result.mssv) + ' đã điểm danh.'
          : (result.fullName || result.mssv) + ' đã điểm danh trước đó.',
        false,
      );
    } catch (error) {
      if (this.shouldRetry(error)) {
        this.setNetworkStatus('OFFLINE');
        await this.queueAndSubmit(checkIn);
        return;
      }
      this.updateRecentCheckIn(checkIn.requestId, {
        status: 'ERROR',
        message: this.errorMessage(error as HttpErrorResponse),
      });
      this.showError(error as HttpErrorResponse);
    }
  }

  private async queueAndSubmit(checkIn: PendingCheckIn): Promise<void> {
    try {
      await this.offlineQueue.add(checkIn.eventId, checkIn.mssv, checkIn.method, checkIn.requestId);
      this.updateRecentCheckIn(checkIn.requestId, { status: 'QUEUED', message: 'Đã lưu trên thiết bị, chờ đồng bộ.' });
      this.showToast(
        navigator.onLine
          ? checkIn.mssv + ' đã được lưu, sẽ tự đồng bộ khi có mạng.'
          : checkIn.mssv + ' đã được xếp vào hàng chờ đồng bộ.',
        false,
      );
    } catch (error) {
      if (error instanceof DuplicateQueuedCheckInError) {
        this.updateRecentCheckIn(checkIn.requestId, { status: 'QUEUED', message: 'Mã này đã có trong hàng chờ đồng bộ.' });
        this.showToast('MSSV ' + error.existing.mssv + ' đã có trong hàng chờ đồng bộ.', false);
        return;
      }
      this.updateRecentCheckIn(checkIn.requestId, { status: 'ERROR', message: 'Không thể lưu lượt điểm danh trên thiết bị.' });
      this.showErrorMessage('Không thể lưu lượt điểm danh trên thiết bị.');
    } finally {
      await this.refreshQueueSummary();
      await this.refreshQueueItems();
    }
  }

  private finishCheckIn(checkIn: PendingCheckIn): void {
    if (!checkIn.scanned) this.isSubmitting = false;
    if (checkIn.scanned) {
      const scanKey = this.scanKey(checkIn.eventId, checkIn.mssv);
      this.activeScanKeys.delete(scanKey);
      this.scanCooldowns.set(scanKey, Date.now());
    }
    this.changeDetector.detectChanges();
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

  private addRecentCheckIn(checkIn: PendingCheckIn): void {
    const recentCheckIn: RecentCheckIn = {
      requestId: checkIn.requestId,
      eventId: checkIn.eventId,
      mssv: checkIn.mssv,
      method: checkIn.method,
      createdAt: new Date().toISOString(),
      status: 'SENDING',
    };
    if (checkIn.eventId === this.selectedEventId) this.recentCheckIns = [recentCheckIn, ...this.recentCheckIns];
    this.persistRecentCheckIn(recentCheckIn);
  }

  private updateRecentCheckIn(requestId: string, changes: Partial<RecentCheckIn>): void {
    let updatedItem: RecentCheckIn | undefined;
    this.recentCheckIns = this.recentCheckIns.map(item => {
      if (item.requestId !== requestId) return item;
      updatedItem = { ...item, ...changes };
      return updatedItem;
    });
    if (updatedItem) this.persistRecentCheckIn(updatedItem);
    else this.persistRecentCheckInUpdate(requestId, changes);
    this.changeDetector.detectChanges();
  }

  private async loadRecentCheckIns(): Promise<void> {
    const eventId = this.selectedEventId;
    if (!eventId) {
      this.recentCheckIns = [];
      return;
    }
    const savedHistory = await this.offlineQueue.historyForEvent(eventId);
    if (eventId !== this.selectedEventId) return;
    const historyByRequestId = new Map(savedHistory.map(item => [item.requestId, item]));
    for (const item of this.recentCheckIns) {
      if (item.eventId === eventId) historyByRequestId.set(item.requestId, item);
    }
    this.recentCheckIns = [...historyByRequestId.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    this.changeDetector.detectChanges();
  }

  private persistRecentCheckIn(item: RecentCheckIn): void {
    this.historySaveChain = this.historySaveChain
      .catch(() => undefined)
      .then(() => this.offlineQueue.saveHistory(item));
  }

  private persistRecentCheckInUpdate(requestId: string, changes: Partial<RecentCheckIn>): void {
    this.historySaveChain = this.historySaveChain
      .catch(() => undefined)
      .then(() => this.offlineQueue.updateHistory(requestId, changes));
  }

  async clearRecentCheckIns(): Promise<void> {
    const eventId = this.selectedEventId;
    if (!eventId || !this.recentCheckIns.length || !window.confirm('Xoá toàn bộ lịch sử quét của sự kiện đang chọn?')) return;
    await this.offlineQueue.clearHistoryForEvent(eventId);
    this.recentCheckIns = [];
    this.changeDetector.detectChanges();
    this.showToast('Đã xoá lịch sử quét của sự kiện đang chọn.', false);
  }

  private updatePendingRequestCount(): void {
    this.pendingRequestCount = this.activeRequestCount + this.pendingCheckIns.length;
    this.changeDetector.detectChanges();
  }

  private async syncPendingCheckIns(): Promise<void> {
    if (this.isSyncing || this.networkStatus !== 'ONLINE') return;
    this.isSyncing = true;
    try {
      for (const item of await this.offlineQueue.pending()) {
        if (this.networkStatus !== 'ONLINE') break;
        await this.submitQueuedCheckIn(item, false);
      }
    } finally {
      this.isSyncing = false;
      await this.refreshQueueSummary();
    }
  }

  private async submitQueuedCheckIn(item: QueuedCheckIn, showResult: boolean): Promise<void> {
    try {
      const result = await firstValueFrom(this.api.checkIn(item.eventId, item.mssv, item.method, item.requestId));
      await this.offlineQueue.remove(item.requestId);
      this.isError = false;
      this.updateRecentCheckIn(item.requestId, {
        status: result.status === 'CHECKED_IN' ? 'CHECKED_IN' : 'ALREADY_CHECKED_IN',
        fullName: result.fullName,
        message: result.status === 'CHECKED_IN' ? 'Điểm danh thành công.' : 'Sinh viên đã điểm danh trước đó.',
      });
      if (showResult) {
        this.stopScanner();
        this.resultDialog = result;
      }
    } catch (error) {
      if (this.shouldRetry(error)) {
        this.setNetworkStatus('OFFLINE');
        if (showResult) this.showToast('Kết nối yếu: lượt điểm danh đã được lưu và sẽ tự đồng bộ.', false);
        return;
      }
      // A response from the server is final for this attempt. Invalid QR/MSSV
      // and other business errors must not leave an item stuck in the queue.
      await this.offlineQueue.remove(item.requestId);
      this.updateRecentCheckIn(item.requestId, {
        status: 'ERROR',
        message: this.errorMessage(error as HttpErrorResponse),
      });
      if (showResult) this.showError(error as HttpErrorResponse);
    } finally {
      await this.refreshQueueSummary();
    }
  }

  private async loadCachedEvents(error: HttpErrorResponse): Promise<void> {
    const cached = await this.offlineQueue.cachedEvents();
    if (cached?.events.length) {
      this.events = cached.events;
      this.selectedEventId = cached.events.find(event => event.status === 'OPEN')?.eventId ?? '';
      this.isLoading = false;
      this.usingCachedEvents = true;
      void this.loadRecentCheckIns();
      if (this.selectedEventId) {
        this.showToast('Đang dùng danh sách sự kiện đã lưu trên thiết bị.', false);
        return;
      }
    }
    this.showError(error);
  }

  private async refreshQueueSummary(): Promise<void> {
    const summary = await this.offlineQueue.summary();
    this.pendingCount = summary.pending;
    this.failedCount = summary.failed;
    this.changeDetector.detectChanges();
  }

  private async refreshQueueItems(): Promise<void> { this.queueItems = await this.offlineQueue.all(); }

  private async prepareQueue(): Promise<void> {
    const removed = await this.offlineQueue.deduplicate();
    await this.refreshQueueSummary();
    if (removed) this.showToast(`Đã gộp ${removed} lượt quét trùng đang chờ đồng bộ.`, false);
  }

  private shouldRetry(error: unknown): boolean {
    if (!(error instanceof HttpErrorResponse)) return true;
    return error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500;
  }

  get isOffline(): boolean { return this.networkStatus !== 'ONLINE'; }
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
      if (syncAfterSuccess) await this.syncPendingCheckIns();
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

  continueScanning(): void { this.resultDialog = undefined; void this.startScanner(); }
  formatCheckedInAt(value: string): string { return new Date(value).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'medium' }); }
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
    this.method = result.getBarcodeFormat() === BarcodeFormat.QR_CODE ? 'QR' : 'BARCODE';
    this.zone.run(() => this.checkIn(mssv, true));
  }
  private scanKey(eventId: string, mssv: string): string { return eventId + '\u0000' + mssv; }
  private showError(error: HttpErrorResponse): void {
    this.showErrorMessage(this.errorMessage(error));
    this.isLoading = false;
  }
  private errorMessage(error: HttpErrorResponse): string {
    const messages: Record<string, string> = {
      EVENT_NOT_FOUND: 'Không tìm thấy sự kiện điểm danh.',
      INVALID_MSSV: 'Mã quét không hợp lệ. Vui lòng quét đúng mã sinh viên.',
      STUDENT_NOT_FOUND: 'Không tìm thấy sinh viên với MSSV này.',
      STUDENT_NOT_REGISTERED: 'Sinh viên chưa được đăng ký trong sự kiện này.',
      EVENT_NOT_OPEN: 'Sự kiện hiện không mở điểm danh.',
    };
    return messages[error.error?.code] || 'Không thể kết nối đến hệ thống điểm danh. Vui lòng thử lại.';
  }
  private showErrorMessage(message: string): void { this.isError = true; this.showToast(message, true); }
  private showToast(message: string, isError: boolean): void {
    this.toastMessage = message;
    this.toastIsError = isError;
    this.changeDetector.detectChanges();
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastMessage = '';
      this.toastIsError = false;
      this.changeDetector.detectChanges();
    }, 2000);
  }
}
