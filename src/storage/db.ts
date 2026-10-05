// IndexedDB 持久层：文件内容 / 版本、操作历史（撤销按整次操作恢复）、元数据。
// 所有跨文件改名在一个事务内写入，并在同一事务里记录前后快照。

import { cyrb53 } from '../shared/protocol';

export interface StoredFile {
  path: string;
  content: string;
  rev: number;
  updatedAt: number;
}

export interface FileSnapshot {
  path: string;
  content: string;
  rev: number;
}

export interface OperationLog {
  id: string;
  kind: 'rename';
  label: string;
  oldName: string;
  newName: string;
  at: number;
  /** 操作前整批文件快照（撤销直接恢复这批） */
  before: FileSnapshot[];
  /** 操作后快照（重做/审计用） */
  after: FileSnapshot[];
  /** 本次实际改动的条目数（仅可证明 + 用户勾选的候选） */
  changedCount: number;
}

const DB_NAME = 'rename-preview-db';
const DB_VERSION = 1;
const STORE_FILES = 'files';
const STORE_HISTORY = 'history';
const STORE_META = 'meta';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_FILES)) {
        db.createObjectStore(STORE_FILES, { keyPath: 'path' });
      }
      if (!db.objectStoreNames.contains(STORE_HISTORY)) {
        const s = db.createObjectStore(STORE_HISTORY, { keyPath: 'id' });
        s.createIndex('at', 'at');
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | IDBRequest<T>[]): Promise<T[]> {
  return openDb().then(
    (db) =>
      new Promise<T[]>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const reqs = [fn(s)].flat();
        const results: T[] = [];
        t.oncomplete = () => resolve(results);
        t.onerror = () => reject(t.error);
        reqs.forEach((r) => r.onsuccess = () => results.push(r.result));
      }),
  );
}

export async function loadAllFiles(): Promise<StoredFile[]> {
  const [rows] = await tx<StoredFile[]>(STORE_FILES, 'readonly', (s) => s.getAll() as IDBRequest<StoredFile[]>);
  return rows ?? [];
}

export async function saveFile(path: string, content: string, rev: number): Promise<void> {
  await tx(STORE_FILES, 'readwrite', (s) =>
    s.put({ path, content, rev, updatedAt: Date.now() } satisfies StoredFile),
  );
}

export async function deleteFile(path: string): Promise<void> {
  await tx(STORE_FILES, 'readwrite', (s) => s.delete(path));
}

/** 跨文件改名 + 历史写入：同一个 readwrite 事务，保证原子性。 */
export async function commitRename(params: {
  changes: FileSnapshot[]; // 操作后的完整文件内容
  before: FileSnapshot[]; // 操作前快照
  oldName: string;
  newName: string;
  changedCount: number;
}): Promise<OperationLog> {
  const db = await openDb();
  const log: OperationLog = {
    id: `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'rename',
    label: `重命名 ${params.oldName} → ${params.newName}（${params.changedCount} 处，${new Set(params.changes.map((c) => c.path)).size} 个文件）`,
    oldName: params.oldName,
    newName: params.newName,
    at: Date.now(),
    before: params.before,
    after: params.changes,
    changedCount: params.changedCount,
  };
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction([STORE_FILES, STORE_HISTORY], 'readwrite');
    const fs = t.objectStore(STORE_FILES);
    const hs = t.objectStore(STORE_HISTORY);
    for (const c of params.changes) {
      fs.put({ path: c.path, content: c.content, rev: c.rev, updatedAt: Date.now() } satisfies StoredFile);
    }
    hs.put(log);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
  return log;
}

/** 按整次操作撤销：恢复该操作 before 里的所有文件（不影响后续未提交编辑之外的文件）。 */
export async function undoOperation(log: OperationLog): Promise<FileSnapshot[]> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction([STORE_FILES, STORE_HISTORY], 'readwrite');
    const fs = t.objectStore(STORE_FILES);
    const hs = t.objectStore(STORE_HISTORY);
    for (const c of log.before) {
      fs.put({ path: c.path, content: c.content, rev: c.rev, updatedAt: Date.now() } satisfies StoredFile);
    }
    hs.delete(log.id);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
  return log.before;
}

export async function loadHistory(): Promise<OperationLog[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_HISTORY, 'readonly');
    const req = t.objectStore(STORE_HISTORY).index('at').getAll();
    req.onsuccess = () => resolve((req.result as OperationLog[]).sort((a, b) => a.at - b.at));
    req.onerror = () => reject(req.error);
  });
}

export async function clearAll(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction([STORE_FILES, STORE_HISTORY], 'readwrite');
    t.objectStore(STORE_FILES).clear();
    t.objectStore(STORE_HISTORY).clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/** 载入验证场景：清空文件与历史，整批写入新工作区（一个事务）。 */
export async function replaceWorkspace(files: { path: string; content: string }[]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction([STORE_FILES, STORE_HISTORY], 'readwrite');
    const fs = t.objectStore(STORE_FILES);
    fs.clear();
    const now = Date.now();
    for (const f of files) {
      fs.put({ path: f.path, content: f.content, rev: 1, updatedAt: now } satisfies StoredFile);
    }
    t.objectStore(STORE_HISTORY).clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export function hashContent(content: string): string {
  return cyrb53(content);
}
