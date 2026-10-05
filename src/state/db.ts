import { contentVersion } from '../engine/version';

/**
 * IndexedDB 持久化：
 * - files：文件草稿（path 主键，带内容版本）
 * - ops：整次操作历史（一次分析+提交或一次编辑保存算一个原子操作），
 *        撤销时把整次操作改动的文件整体恢复到操作前版本。
 *
 * 全程本地，无后端；只保存文本，不执行其中任何代码。
 */

const DB_NAME = 'rename-studio';
const DB_VERSION = 1;
const STORE_FILES = 'files';
const STORE_OPS = 'ops';

export interface StoredFile {
  path: string;
  content: string;
  version: string;
  updatedAt: number;
}

export interface OperationRecord {
  id: string;
  kind: 'rename' | 'edit-save';
  label: string;
  oldName?: string;
  newName?: string;
  createdAt: number;
  /** 操作后受影响文件版本，用于核对 */
  after: Array<{ path: string; version: string }>;
  /** 操作前全部受影响文件的完整内容（回滚时整体恢复） */
  beforeFiles: StoredFile[];
}

let dbPromise: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_FILES)) {
        db.createObjectStore(STORE_FILES, { keyPath: 'path' });
      }
      if (!db.objectStoreNames.contains(STORE_OPS)) {
        const s = db.createObjectStore(STORE_OPS, { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export const db = {
  async loadFiles(): Promise<StoredFile[]> {
    const dbx = await openDb();
    return await new Promise<StoredFile[]>((resolve, reject) => {
      const t = dbx.transaction(STORE_FILES, 'readonly');
      const req = t.objectStore(STORE_FILES).getAll();
      req.onsuccess = () => resolve(req.result as StoredFile[]);
      req.onerror = () => reject(req.error);
    });
  },

  async putFile(path: string, content: string): Promise<void> {
    const record: StoredFile = {
      path,
      content,
      version: contentVersion(content),
      updatedAt: Date.now(),
    };
    const dbx = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = dbx.transaction(STORE_FILES, 'readwrite');
      t.objectStore(STORE_FILES).put(record);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },

  async putFiles(files: StoredFile[]): Promise<void> {
    const dbx = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = dbx.transaction(STORE_FILES, 'readwrite');
      const store = t.objectStore(STORE_FILES);
      const now = Date.now();
      for (const f of files) {
        store.put({ ...f, version: contentVersion(f.content), updatedAt: now });
      }
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },

  async addOp(record: OperationRecord): Promise<void> {
    const dbx = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = dbx.transaction(STORE_OPS, 'readwrite');
      t.objectStore(STORE_OPS).add(record);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  },

  async listOps(): Promise<OperationRecord[]> {
    const dbx = await openDb();
    const rows: OperationRecord[] = await new Promise((resolve, reject) => {
      const t = dbx.transaction(STORE_OPS, 'readonly');
      const idx = t.objectStore(STORE_OPS).index('createdAt');
      const req = idx.getAll();
      req.onsuccess = () => resolve(req.result as OperationRecord[]);
      req.onerror = () => reject(req.error);
    });
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  },
};

/**
 * 原子地：写入操作后文件 + 记录操作历史。
 * 撤销（restoreOp）则整体写回 beforeFiles 并移除该条历史。
 */
export async function commitOperation(
  record: OperationRecord,
  afterFiles: StoredFile[],
): Promise<void> {
  const dbx = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = dbx.transaction([STORE_OPS, STORE_FILES], 'readwrite');
    t.objectStore(STORE_OPS).add(record);
    const now = Date.now();
    for (const f of afterFiles) {
      t.objectStore(STORE_FILES).put({
        ...f,
        version: contentVersion(f.content),
        updatedAt: now,
      });
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function restoreOperation(record: OperationRecord): Promise<void> {
  const dbx = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = dbx.transaction([STORE_OPS, STORE_FILES], 'readwrite');
    t.objectStore(STORE_OPS).delete(record.id);
    const now = Date.now();
    for (const f of record.beforeFiles) {
      t.objectStore(STORE_FILES).put({
        ...f,
        version: contentVersion(f.content),
        updatedAt: now,
      });
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
