import { Injectable } from '@angular/core';
import { DBSchema, IDBPDatabase, openDB } from 'idb';
import { EventSummary, ScanRequest, Ticket } from './http.service';

export type LocalScanStatus = 'QUEUED' | 'SYNCED' | 'REJECTED' | 'CONFLICT' | 'ERROR';

export interface QueuedScan {
  clientEventId: string;
  eventId: string;
  ticketCode: string;
  payload: ScanRequest;
  createdAt: number;
  attempts: number;
  lastError?: string;
  syncState?: 'PENDING' | 'FAILED';
}

export interface ScanHistoryItem {
  clientEventId: string;
  eventId: string;
  ticketCode: string;
  outcome: ScanRequest['outcome'];
  entryMode: ScanRequest['entryMode'];
  createdAt: number;
  status: LocalScanStatus;
  holderName?: string;
  message?: string;
}

export interface SyncState {
  eventId: string;
  rosterVersion: number;
  scansSince: number;
}

interface CachedEvents {
  id: 'events';
  events: EventSummary[];
  cachedAt: number;
}

interface StoredTicket extends Ticket {
  eventId: string;
}

interface DeviceState {
  id: 'device';
  deviceId: string;
  sequence: number;
  selectedEventId?: string;
  legacyHistoryMigrated?: boolean;
}

interface LegacyHistoryItem {
  requestId: string;
  eventId: string;
  mssv: string;
  method: 'QR' | 'BARCODE' | 'MANUAL';
  createdAt: string;
  status: 'SENDING' | 'QUEUED' | 'CHECKED_IN' | 'ALREADY_CHECKED_IN' | 'ERROR';
  fullName?: string;
  message?: string;
}

interface LegacyOfflineDb extends DBSchema {
  'check-in-history': { key: string; value: LegacyHistoryItem };
}

interface TempleKeeperOfflineDb extends DBSchema {
  events: { key: string; value: CachedEvents };
  tickets: { key: [string, string]; value: StoredTicket; indexes: { 'by-event': string } };
  sync: { key: string; value: SyncState };
  'scan-queue': { key: string; value: QueuedScan; indexes: { 'by-event': string; 'by-event-ticket': [string, string] } };
  'scan-history': { key: string; value: ScanHistoryItem; indexes: { 'by-event': string } };
  device: { key: string; value: DeviceState };
}

@Injectable({ providedIn: 'root' })
export class OfflineCheckInQueueService {
  private readonly database = openDB<TempleKeeperOfflineDb>('templekeeper-offline', 1, {
    upgrade(db) {
      db.createObjectStore('events', { keyPath: 'id' });
      const tickets = db.createObjectStore('tickets', { keyPath: ['eventId', 'ticketCode'] });
      tickets.createIndex('by-event', 'eventId');
      db.createObjectStore('sync', { keyPath: 'eventId' });
      const queue = db.createObjectStore('scan-queue', { keyPath: 'clientEventId' });
      queue.createIndex('by-event', 'eventId');
      queue.createIndex('by-event-ticket', ['eventId', 'ticketCode']);
      const history = db.createObjectStore('scan-history', { keyPath: 'clientEventId' });
      history.createIndex('by-event', 'eventId');
      db.createObjectStore('device', { keyPath: 'id' });
    },
  });

  async cacheEvents(events: EventSummary[]): Promise<void> {
    await (await this.database).put('events', { id: 'events', events, cachedAt: Date.now() });
  }

  async cachedEvents(): Promise<CachedEvents | undefined> {
    return (await this.database).get('events', 'events');
  }

  async getSyncState(eventId: string): Promise<SyncState> {
    return (await (await this.database).get('sync', eventId)) ?? { eventId, rosterVersion: 0, scansSince: 0 };
  }

  async saveRosterVersion(eventId: string, rosterVersion: number): Promise<void> {
    const database = await this.database;
    const current = await this.getSyncState(eventId);
    await database.put('sync', { ...current, rosterVersion });
  }

  async saveScansSince(eventId: string, scansSince: number): Promise<void> {
    const database = await this.database;
    const current = await this.getSyncState(eventId);
    await database.put('sync', { ...current, scansSince });
  }

  async applyRosterPage(eventId: string, tickets: Ticket[]): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction('tickets', 'readwrite');
    for (const ticket of tickets) {
      const key: [string, string] = [eventId, ticket.ticketCode];
      if (ticket.deleted) await transaction.store.delete(key);
      else await transaction.store.put({ ...ticket, eventId, deleted: false });
    }
    await transaction.done;
  }

  async getTicket(eventId: string, ticketCode: string): Promise<Ticket | undefined> {
    const ticket = await (await this.database).get('tickets', [eventId, ticketCode]);
    return ticket;
  }

  async hasRoster(eventId: string): Promise<boolean> {
    return (await (await this.database).countFromIndex('tickets', 'by-event', eventId)) > 0;
  }

  async pendingTicket(eventId: string, ticketCode: string): Promise<boolean> {
    return !!(await (await this.database).getFromIndex('scan-queue', 'by-event-ticket', [eventId, ticketCode]));
  }

  async enqueue(scan: ScanRequest, holderName?: string, allowSameTicket = false): Promise<boolean> {
    const database = await this.database;
    const transaction = database.transaction(['scan-queue', 'scan-history'], 'readwrite');
    const queue = transaction.objectStore('scan-queue');
    const existing = allowSameTicket
      ? undefined
      : await queue.index('by-event-ticket').get([scan.eventId, scan.ticketCode]);
    if (existing) {
      await transaction.done;
      return false;
    }
    await queue.add({
      clientEventId: scan.clientEventId,
      eventId: scan.eventId,
      ticketCode: scan.ticketCode,
      payload: scan,
      createdAt: Date.now(),
      attempts: 0,
      syncState: 'PENDING',
    });
    await transaction.objectStore('scan-history').put({
      clientEventId: scan.clientEventId,
      eventId: scan.eventId,
      ticketCode: scan.ticketCode,
      outcome: scan.outcome,
      entryMode: scan.entryMode,
      createdAt: scan.scannedAtWallClock,
      status: 'QUEUED',
      holderName,
    });
    await transaction.done;
    return true;
  }

  async pendingForEvent(eventId: string, limit = 500): Promise<QueuedScan[]> {
    return (await (await this.database).getAllFromIndex('scan-queue', 'by-event', eventId))
      .filter(item => item.syncState !== 'FAILED')
      .sort((left, right) => left.createdAt - right.createdAt)
      .slice(0, limit);
  }

  async queuedEvents(): Promise<string[]> {
    const scans = await (await this.database).getAll('scan-queue');
    return [...new Set(scans.filter(scan => scan.syncState !== 'FAILED').map(scan => scan.eventId))];
  }

  async all(): Promise<QueuedScan[]> {
    return (await (await this.database).getAll('scan-queue')).sort((left, right) => left.createdAt - right.createdAt);
  }

  async summary(): Promise<{ pending: number; failed: number }> {
    const scans = await (await this.database).getAll('scan-queue');
    return scans.reduce((summary, scan) => {
      summary[scan.syncState === 'FAILED' ? 'failed' : 'pending'] += 1;
      return summary;
    }, { pending: 0, failed: 0 });
  }

  async acknowledge(clientEventIds: string[]): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction('scan-queue', 'readwrite');
    for (const clientEventId of clientEventIds) await transaction.store.delete(clientEventId);
    await transaction.done;
  }

  async markAttempt(clientEventIds: string[], message: string): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction('scan-queue', 'readwrite');
    for (const clientEventId of clientEventIds) {
      const queued = await transaction.store.get(clientEventId);
      if (queued) await transaction.store.put({ ...queued, attempts: queued.attempts + 1, lastError: message });
    }
    await transaction.done;
  }

  async retryFailed(): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction('scan-queue', 'readwrite');
    const scans = await transaction.store.getAll();
    for (const scan of scans) {
      if (scan.syncState === 'FAILED') await transaction.store.put({ ...scan, syncState: 'PENDING' });
    }
    await transaction.done;
  }

  async markFailed(clientEventIds: string[], message: string): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction('scan-queue', 'readwrite');
    for (const clientEventId of clientEventIds) {
      const queued = await transaction.store.get(clientEventId);
      if (queued) await transaction.store.put({ ...queued, syncState: 'FAILED', lastError: message });
    }
    await transaction.done;
  }

  async migrateLegacyHistory(): Promise<number> {
    const database = await this.database;
    const device = await database.get('device', 'device');
    if (device?.legacyHistoryMigrated) return 0;
    let migrated = 0;
    let legacy: IDBPDatabase<LegacyOfflineDb> | undefined;
    try {
      legacy = await openDB<LegacyOfflineDb>('attendance-offline');
      if (legacy.objectStoreNames.contains('check-in-history')) {
        const oldItems = await legacy.getAll('check-in-history');
        const transaction = database.transaction('scan-history', 'readwrite');
        for (const oldItem of oldItems) {
          if (await transaction.store.get(oldItem.requestId)) continue;
          const completed = oldItem.status === 'CHECKED_IN';
          const duplicate = oldItem.status === 'ALREADY_CHECKED_IN';
          await transaction.store.put({
            clientEventId: oldItem.requestId,
            eventId: oldItem.eventId,
            ticketCode: oldItem.mssv,
            outcome: completed ? 'ADMITTED' : duplicate ? 'REJECTED_ALREADY_USED' : 'REJECTED_NOT_FOUND',
            entryMode: oldItem.method,
            createdAt: Date.parse(oldItem.createdAt) || Date.now(),
            status: completed ? 'SYNCED' : duplicate ? 'CONFLICT' : 'ERROR',
            holderName: oldItem.fullName,
            message: oldItem.message || (completed ? 'Điểm danh thành công.' : duplicate ? 'Đã điểm danh trước đó.' : 'Dữ liệu từ phiên bản cũ cần được đối chiếu.'),
          });
          migrated += 1;
        }
        await transaction.done;
      }
    } catch {
      return 0;
    } finally {
      legacy?.close();
    }
    const transaction = database.transaction('device', 'readwrite');
    const stored = await transaction.store.get('device');
    const state = stored ?? { id: 'device' as const, deviceId: crypto.randomUUID(), sequence: 0 };
    await transaction.store.put({ ...state, legacyHistoryMigrated: true });
    await transaction.done;
    return migrated;
  }

  async selectedEventId(): Promise<string> {
    return (await (await this.database).get('device', 'device'))?.selectedEventId ?? '';
  }

  async saveSelectedEventId(selectedEventId: string): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction('device', 'readwrite');
    const stored = await transaction.store.get('device');
    const state = stored ?? { id: 'device' as const, deviceId: crypto.randomUUID(), sequence: 0 };
    await transaction.store.put({ ...state, selectedEventId });
    await transaction.done;
  }

  async updateHistory(clientEventId: string, changes: Partial<ScanHistoryItem>): Promise<void> {
    const database = await this.database;
    const item = await database.get('scan-history', clientEventId);
    if (item) await database.put('scan-history', { ...item, ...changes });
  }

  async allHistory(): Promise<ScanHistoryItem[]> {
    return (await (await this.database).getAll('scan-history'))
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  async historyForEvent(eventId: string): Promise<ScanHistoryItem[]> {
    return (await (await this.database).getAllFromIndex('scan-history', 'by-event', eventId))
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  async deviceIdentity(): Promise<string> {
    const database = await this.database;
    const stored = await database.get('device', 'device');
    if (stored) return stored.deviceId;
    const device: DeviceState = { id: 'device', deviceId: crypto.randomUUID(), sequence: 0 };
    await database.add('device', device);
    return device.deviceId;
  }

  async nextDeviceSequence(): Promise<number> {
    const database = await this.database;
    const transaction = database.transaction('device', 'readwrite');
    const stored = await transaction.store.get('device');
    const state = stored ?? { id: 'device' as const, deviceId: crypto.randomUUID(), sequence: 0 };
    const next = state.sequence + 1;
    await transaction.store.put({ ...state, sequence: next });
    await transaction.done;
    return next;
  }
}
