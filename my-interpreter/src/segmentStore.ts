/**
 * Durable PCM segment store so meeting audio is never dropped when translation lags.
 * All writes are serialized to avoid late putSegment overwriting a newer done/cleared state.
 */

import type { SegmentJob, SegmentJobStatus } from './types';

const DB_NAME = 'interpreter-segments-v1';
const DB_VERSION = 1;
const STORE = 'segments';

/** Warn (do not drop) when buffered unfinished audio exceeds this. */
export const WARN_BUFFERED_MS = 30 * 60_000;

export const PARALLEL_WORKERS = 2;
export const MAX_SEGMENT_ATTEMPTS = 4;

export interface StoredSegmentMeta {
  localId: number;
  sessionId: string;
  segmentIndex: number;
  durationMs: number;
  status: SegmentJobStatus;
  attempts: number;
  error?: string;
  enqueuedAt: number;
  /** Monotonic per-job write counter; older writes are ignored. */
  revision: number;
  /** Cleared after done/empty to free disk; kept for failed so Retry works. */
  pcm?: ArrayBuffer;
}

let writeChain: Promise<void> = Promise.resolve();

/** Run IDB mutations strictly in order (prevents late put resurrecting stale PCM). */
function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'localId' });
        store.createIndex('sessionId', 'sessionId', { unique: false });
        store.createIndex('status', 'status', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

export async function clearAllSegments(): Promise<void> {
  return enqueueWrite(async () => {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  });
}

export async function putSegment(meta: StoredSegmentMeta): Promise<void> {
  return enqueueWrite(async () => {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const existing = (await idbReq(store.get(meta.localId))) as StoredSegmentMeta | undefined;
      if (existing && existing.revision > meta.revision) {
        // Stale write — ignore
      } else {
        store.put(meta);
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  });
}

export async function updateSegment(
  localId: number,
  patch: Partial<Pick<StoredSegmentMeta, 'status' | 'attempts' | 'error' | 'pcm' | 'revision'>>,
): Promise<void> {
  return enqueueWrite(async () => {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const existing = (await idbReq(store.get(localId))) as StoredSegmentMeta | undefined;
      if (!existing) return;
      if (patch.revision != null && existing.revision > patch.revision) return;
      const next: StoredSegmentMeta = { ...existing, ...patch };
      if (patch.pcm === undefined && (patch.status === 'done' || patch.status === 'empty')) {
        next.pcm = undefined;
      }
      store.put(next);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  });
}

export async function getSegmentPcm(localId: number): Promise<ArrayBuffer | null> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readonly');
    const existing = (await idbReq(tx.objectStore(STORE).get(localId))) as StoredSegmentMeta | undefined;
    if (!existing?.pcm || existing.pcm.byteLength === 0) return null;
    return existing.pcm;
  } finally {
    db.close();
  }
}

export function jobToStored(job: SegmentJob, sessionId: string, revision: number): StoredSegmentMeta {
  return {
    localId: job.localId,
    sessionId,
    segmentIndex: job.segmentIndex,
    durationMs: job.durationMs,
    status: job.status,
    attempts: job.attempts,
    error: job.error,
    enqueuedAt: job.enqueuedAt,
    revision,
    pcm: job.pcm.byteLength > 0 ? job.pcm : undefined,
  };
}

export function bufferedUnfinishedMs(jobs: SegmentJob[]): number {
  return jobs
    .filter((j) => j.status === 'queued' || j.status === 'processing')
    .reduce((n, j) => n + j.durationMs, 0);
}
