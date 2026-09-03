import { Injectable } from '@angular/core';
import { DBSchema, openDB } from 'idb';
import { CheckInMethod, EventSummary } from './http.service';

export interface QueuedCheckIn {
  requestId: string;
  eventId: string;
  mssv: string;
  method: CheckInMethod;
  capturedAt: string;
  status: 'PENDING' | 'FAILED';
  lastError?: string;
}

export type CheckInHistoryStatus = 'SENDING' | 'QUEUED' | 'CHECKED_IN' | 'ALREADY_CHECKED_IN' | 'ERROR';

export interface CheckInHistoryItem {
  requestId: string;
  eventId: string;
  mssv: string;
  method: CheckInMethod;
  createdAt: string;
  status: CheckInHistoryStatus;
  fullName?: string;
  message?: string;
}

export class DuplicateQueuedCheckInError extends Error {
  constructor(public readonly existing: QueuedCheckIn) {
    super('This student already has a queued check-in for the event.');
  }
}

interface CachedEvents {
  id: 'events';
  events: EventSummary[];
  cachedAt: string;
}

interface AttendanceOfflineDb extends DBSchema {
  'check-in-queue': {
    key: string;
    value: QueuedCheckIn;
    indexes: { 'by-status': string; 'by-captured-at': string; 'by-event-mssv': [string, string] };
  };
  'cached-events': { key: string; value: CachedEvents };
  'check-in-history': {
    key: string;
    value: CheckInHistoryItem;
    indexes: { 'by-created-at': string; 'by-event-id': string };
  };
}

@Injectable({ providedIn: 'root' })
export class OfflineCheckInQueueService {
  private readonly database = openDB<AttendanceOfflineDb>('attendance-offline', 5, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      const queue = oldVersion === 0
        ? db.createObjectStore('check-in-queue', { keyPath: 'requestId' })
        : transaction.objectStore('check-in-queue');
      if (!queue.indexNames.contains('by-status')) queue.createIndex('by-status', 'status');
      if (!queue.indexNames.contains('by-captured-at')) queue.createIndex('by-captured-at', 'capturedAt');
      if (queue.indexNames.contains('by-event-mssv')) queue.deleteIndex('by-event-mssv');
      queue.createIndex('by-event-mssv', ['eventId', 'mssv']);
      if (oldVersion === 0) db.createObjectStore('cached-events', { keyPath: 'id' });

      const history = db.objectStoreNames.contains('check-in-history')
        ? transaction.objectStore('check-in-history')
        : db.createObjectStore('check-in-history', { keyPath: 'requestId' });
      if (!history.indexNames.contains('by-created-at')) history.createIndex('by-created-at', 'createdAt');
      if (!history.indexNames.contains('by-event-id')) history.createIndex('by-event-id', 'eventId');
    },
  });

  async add(eventId: string, mssv: string, method: CheckInMethod, requestId: string = crypto.randomUUID()): Promise<QueuedCheckIn> {
    const database = await this.database;
    const normalizedMssv = mssv.trim().toUpperCase();
    const transaction = database.transaction('check-in-queue', 'readwrite');
    const existing = await transaction.store.index('by-event-mssv').get([eventId, normalizedMssv]);
    if (existing) throw new DuplicateQueuedCheckInError(existing);
    const item: QueuedCheckIn = {
      requestId, eventId, mssv: normalizedMssv, method,
      capturedAt: new Date().toISOString(), status: 'PENDING',
    };
    await transaction.store.add(item);
    await transaction.done;
    return item;
  }

  async deduplicate(): Promise<number> {
    const database = await this.database;
    const transaction = database.transaction('check-in-queue', 'readwrite');
    const items = (await transaction.store.getAll()).sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
    const seen = new Set<string>();
    let removed = 0;
    for (const item of items) {
      const mssv = item.mssv.trim().toUpperCase();
      const key = `${item.eventId}\u0000${mssv}`;
      if (seen.has(key)) {
        await transaction.store.delete(item.requestId);
        removed += 1;
      } else {
        seen.add(key);
        if (item.mssv !== mssv) await transaction.store.put({ ...item, mssv });
      }
    }
    await transaction.done;
    return removed;
  }

  async pending(): Promise<QueuedCheckIn[]> {
    const database = await this.database;
    return (await database.getAllFromIndex('check-in-queue', 'by-status', 'PENDING'))
      .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
  }

  async all(): Promise<QueuedCheckIn[]> {
    return (await (await this.database).getAll('check-in-queue'))
      .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
  }

  async summary(): Promise<{ pending: number; failed: number }> {
    const items = await (await this.database).getAll('check-in-queue');
    return items.reduce((summary, item) => {
      summary[item.status === 'PENDING' ? 'pending' : 'failed'] += 1;
      return summary;
    }, { pending: 0, failed: 0 });
  }

  async remove(requestId: string): Promise<void> { await (await this.database).delete('check-in-queue', requestId); }

  async markFailed(requestId: string, message: string): Promise<void> {
    const database = await this.database;
    const item = await database.get('check-in-queue', requestId);
    if (item) await database.put('check-in-queue', { ...item, status: 'FAILED', lastError: message });
  }

  async retryFailed(): Promise<void> {
    const database = await this.database;
    const failed = await database.getAllFromIndex('check-in-queue', 'by-status', 'FAILED');
    await Promise.all(failed.map(item => database.put('check-in-queue', { ...item, status: 'PENDING', lastError: undefined })));
  }

  async cacheEvents(events: EventSummary[]): Promise<void> {
    await (await this.database).put('cached-events', { id: 'events', events, cachedAt: new Date().toISOString() });
  }

  async cachedEvents(): Promise<CachedEvents | undefined> { return (await this.database).get('cached-events', 'events'); }

  async saveHistory(item: CheckInHistoryItem): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction('check-in-history', 'readwrite');
    await transaction.store.put(item);
    await transaction.done;
  }

  async historyForEvent(eventId: string): Promise<CheckInHistoryItem[]> {
    const database = await this.database;
    return (await database.getAllFromIndex('check-in-history', 'by-event-id', eventId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async updateHistory(requestId: string, changes: Partial<CheckInHistoryItem>): Promise<void> {
    const database = await this.database;
    const item = await database.get('check-in-history', requestId);
    if (item) await database.put('check-in-history', { ...item, ...changes });
  }

  async clearHistoryForEvent(eventId: string): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction('check-in-history', 'readwrite');
    const keys = await transaction.store.index('by-event-id').getAllKeys(eventId);
    for (const key of keys) await transaction.store.delete(key);
    await transaction.done;
  }
}
