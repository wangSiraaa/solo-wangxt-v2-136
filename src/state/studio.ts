import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as MonacoNS from 'monaco-editor';
import { EngineClient } from '../engine/engineClient';
import type {
  ProjectSnapshot,
  RenameAnalysisResult,
} from '../engine/types';
import { contentVersion } from '../engine/version';
import { buildEdits } from '../engine/renameBuilder';
import { applyEdits, type FileEdit } from '../engine/edit';
import { evaluateGate, isValidIdentifier } from '../engine/gate';
import {
  db,
  commitOperation,
  restoreOperation,
  type OperationRecord,
  type StoredFile,
} from './db';
import { SEED_FILES } from '../seed/sampleProject';

export interface DocInfo {
  path: string;
  content: string;
  version: string;
}

export interface RenameSession {
  result: RenameAnalysisResult;
  newName: string;
  selected: Set<string>;
  /** 逐条确认过的 dynamic 命中 id（未覆盖位置） */
  dynamicChecked: Set<string>;
  analyzing: boolean;
}

export interface CommitOutcome {
  changedFiles: string[];
  replacedCount: number;
  opId: string;
}

const SCHEMA_VERSION_KEY = 'rename-studio:schema';

export function useStudio(
  editorRef: React.MutableRefObject<{
    monaco: typeof MonacoNS;
    editor: MonacoNS.editor.IStandaloneCodeEditor;
  } | null>,
) {
  const [docs, setDocs] = useState<Record<string, DocInfo>>({});
  const [activePath, setActivePath] = useState<string>('');
  const [loaded, setLoaded] = useState(false);
  const [session, setSession] = useState<RenameSession | null>(null);
  const [history, setHistory] = useState<OperationRecord[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const engineRef = useRef<EngineClient | null>(null);

  /* ---------- 启动：IndexedDB -> 种子 -> Worker ---------- */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let stored = await db.loadFiles();
      if (stored.length === 0) {
        const seeded: StoredFile[] = SEED_FILES.map((f) => ({
          path: f.path,
          content: f.content,
          version: contentVersion(f.content),
          updatedAt: Date.now(),
        }));
        await db.putFiles(seeded);
        stored = seeded;
      }
      if (cancelled) return;
      const map: Record<string, DocInfo> = {};
      for (const f of stored) {
        map[f.path] = {
          path: f.path,
          content: f.content,
          version: f.version || contentVersion(f.content),
        };
      }
      const snapshot: ProjectSnapshot = {
        files: stored.map((f) => ({
          path: f.path,
          content: f.content,
          version: f.version,
        })),
      };
      engineRef.current = new EngineClient(snapshot);
      setDocs(map);
      setActivePath(stored[0]?.path ?? '');
      setHistory(await db.listOps());
      setLoaded(true);
      localStorage.setItem(SCHEMA_VERSION_KEY, '1');
    })();
    return () => {
      cancelled = true;
      engineRef.current?.dispose();
    };
  }, []);

  const persistTimer = useRef<number | undefined>();
  const updateDoc = useCallback((path: string, content: string) => {
    const version = contentVersion(content);
    setDocs((prev) => {
      if (prev[path]?.content === content) return prev;
      return { ...prev, [path]: { path, content, version } };
    });
    window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      void db.putFile(path, content);
    }, 120);
    // Worker 侧的更新合并防抖；analyze() 会先强制 flush，保证分析基于最新草稿。
    engineRef.current?.updateFile(path, content, version);
  }, []);

  /* ---------- 分析 ---------- */
  const analyzeAt = useCallback(
    async (fileName: string, position: number, oldName: string) => {
      if (!engineRef.current) return;
      setSession((s) =>
        s
          ? { ...s, analyzing: true }
          : {
              result: EMPTY_SESSION_PLACEHOLDER,
              newName: oldName,
              selected: new Set(),
              dynamicChecked: new Set(),
              analyzing: true,
            },
      );
      const baseVersions: Record<string, string> = {};
      for (const d of Object.values(docs)) baseVersions[d.path] = d.version;
      const result = await engineRef.current.analyze({
        baseVersions,
        fileName,
        position,
        oldName,
      });
      const selected = new Set(
        result.occurrences.filter((o) => o.kind === 'proven').map((o) => o.id),
      );
      setSession({
        result,
        newName: oldName,
        selected,
        dynamicChecked: new Set(),
        analyzing: false,
      });
    },
    [docs],
  );

  const cancelSession = useCallback(() => setSession(null), []);

  const setNewName = useCallback((newName: string) => {
    setSession((s) => (s ? { ...s, newName } : s));
  }, []);

  const toggleOccurrence = useCallback((id: string, on: boolean) => {
    setSession((s) => {
      if (!s) return s;
      const selected = new Set(s.selected);
      if (on) selected.add(id);
      else selected.delete(id);
      return { ...s, selected };
    });
  }, []);

  const toggleSelectAllProven = useCallback((on: boolean) => {
    setSession((s) => {
      if (!s) return s;
      return {
        ...s,
        selected: on
          ? new Set(
              s.result.occurrences
                .filter((o) => o.kind === 'proven')
                .map((o) => o.id),
            )
          : new Set(),
      };
    });
  }, []);

  const toggleDynamicChecked = useCallback((id: string, on: boolean) => {
    setSession((s) => {
      if (!s) return s;
      const dynamicChecked = new Set(s.dynamicChecked);
      if (on) dynamicChecked.add(id);
      else dynamicChecked.delete(id);
      return { ...s, dynamicChecked };
    });
  }, []);

  /* ---------- 当前版本（供过期检测 / 提交闸门） ---------- */
  const currentVersions = useMemo(() => {
    const m: Record<string, string> = {};
    for (const d of Object.values(docs)) m[d.path] = d.version;
    return m;
  }, [docs]);

  const gate = useMemo(() => {
    if (!session) return null;
    return evaluateGate({
      result: session.result,
      currentVersions,
      newName: session.newName,
      selectedIds: session.selected,
      dynamicReviewed:
        session.result.occurrences
          .filter((o) => o.kind === 'dynamic')
          .every((o) => session.dynamicChecked.has(o.id)),
    });
  }, [session, currentVersions]);

  const previewEdits = useMemo(() => {
    if (!session || !gate) return new Map<string, FileEdit>();
    const edits = buildEdits(gate.selected, session.newName);
    const out = new Map<string, FileEdit>();
    for (const [path, list] of edits) {
      out.set(path, {
        path,
        oldContent: docs[path]?.content ?? '',
        edits: list,
      });
    }
    return out;
  }, [session, gate, docs]);

  /* ---------- 提交（整次操作原子落库） ---------- */
  const commit = useCallback(async (): Promise<CommitOutcome | null> => {
    if (!session || !gate?.ok) return null;
    const selected = gate.selected;
    const editsByPath = buildEdits(selected, session.newName);

    // 复核共同版本：以 docs 中的当前内容为基准（闸门已证明其 == 分析版本）。
    const beforeFiles: StoredFile[] = [];
    const afterFiles: StoredFile[] = [];
    const nextDocs: Record<string, DocInfo> = {};
    for (const [path, edits] of editsByPath) {
      const oldContent = docs[path]?.content ?? '';
      const newContent = applyEdits(oldContent, edits);
      if (newContent === oldContent) continue;
      beforeFiles.push({
        path,
        content: oldContent,
        version: contentVersion(oldContent),
        updatedAt: Date.now(),
      });
      afterFiles.push({
        path,
        content: newContent,
        version: contentVersion(newContent),
        updatedAt: Date.now(),
      });
      nextDocs[path] = {
        path,
        content: newContent,
        version: contentVersion(newContent),
      };
    }
    if (afterFiles.length === 0) return null;

    const op: OperationRecord = {
      id: `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'rename',
      label: `${session.result.oldName} → ${session.newName}`,
      oldName: session.result.oldName,
      newName: session.newName,
      createdAt: Date.now(),
      after: afterFiles.map((f) => ({ path: f.path, version: f.version })),
      beforeFiles,
    };
    await commitOperation(op, afterFiles);

    // 同步 Monaco 模型与 Worker（setEditorValue 会触发 change，去重后内容一致）
    const { monaco } = editorRef.current ?? {};
    if (monaco) {
      for (const f of afterFiles) {
        const uri = monaco.Uri.parse(`file:///project/${f.path}`);
        const model = monaco.editor.getModel(uri);
        if (model && model.getValue() !== f.content) {
          model.pushStackElement();
          model.setValue(f.content);
        }
        engineRef.current?.updateFile(f.path, f.content, f.version);
      }
    }
    setDocs((prev) => ({ ...prev, ...nextDocs }));
    setHistory(await db.listOps());
    setSession(null);
    return {
      changedFiles: afterFiles.map((f) => f.path),
      replacedCount: selected.length,
      opId: op.id,
    };
  }, [session, gate, docs, editorRef]);

  /* ---------- 撤销：整次操作恢复 ---------- */
  const undo = useCallback(
    async (record: OperationRecord): Promise<{ conflicts: string[] }> => {
      // 若操作之后文件又被改动，列为冲突但仍可强制恢复（由 UI 二次确认）。
      const conflicts: string[] = [];
      for (const a of record.after) {
        if (docs[a.path] && docs[a.path].version !== a.version) {
          conflicts.push(a.path);
        }
      }
      await restoreOperation(record);
      const { monaco } = editorRef.current ?? {};
      const restored: Record<string, DocInfo> = {};
      for (const f of record.beforeFiles) {
        const version = contentVersion(f.content);
        restored[f.path] = { path: f.path, content: f.content, version };
        if (monaco) {
          const uri = monaco.Uri.parse(`file:///project/${f.path}`);
          const model = monaco.editor.getModel(uri);
          if (model && model.getValue() !== f.content) {
            model.pushStackElement();
            model.setValue(f.content);
          }
        }
        engineRef.current?.updateFile(f.path, f.content, f.version);
      }
      setDocs((prev) => ({ ...prev, ...restored }));
      setSession(null);
      setHistory(await db.listOps());
      return { conflicts };
    },
    [docs, editorRef],
  );

  const reloadSeed = useCallback(async () => {
    const seeded: StoredFile[] = SEED_FILES.map((f) => ({
      path: f.path,
      content: f.content,
      version: contentVersion(f.content),
      updatedAt: Date.now(),
    }));
    await db.putFiles(seeded);
    const map: Record<string, DocInfo> = {};
    for (const f of seeded) {
      map[f.path] = { path: f.path, content: f.content, version: f.version };
      engineRef.current?.updateFile(f.path, f.content, f.version);
    }
    setDocs(map);
    setActivePath(seeded[0].path);
    setSession(null);
  }, []);

  const createScratchFile = useCallback(
    async (path: string, content: string) => {
      await db.putFile(path, content);
      const version = contentVersion(content);
      engineRef.current?.updateFile(path, content, version);
      setDocs((prev) => ({
        ...prev,
        [path]: { path, content, version },
      }));
      setActivePath(path);
      setSession(null);
    },
    [],
  );

  const flashNotice = useCallback((msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 4000);
  }, []);

  return {
    loaded,
    docs,
    activePath,
    setActivePath,
    updateDoc,
    analyzeAt,
    session,
    cancelSession,
    setNewName,
    toggleOccurrence,
    toggleSelectAllProven,
    toggleDynamicChecked,
    gate,
    previewEdits,
    commit,
    undo,
    history,
    reloadSeed,
    createScratchFile,
    notice,
    flashNotice,
    isValidNewName: (n: string) => isValidIdentifier(n),
  };
}

export type StudioApi = ReturnType<typeof useStudio>;

const EMPTY_SESSION_PLACEHOLDER: RenameAnalysisResult = {
  status: 'ok',
  oldName: '',
  triggerFileName: '',
  triggerPosition: 0,
  propertyLike: false,
  occurrences: [],
  blockingSyntax: [],
  otherSyntax: [],
  analyzedVersions: {},
  baseVersions: {},
};
