import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorPane } from './EditorPane';
import { PreviewPanel } from './PreviewPanel';
import { HistoryPanel } from './HistoryPanel';
import { tsWorker } from '../worker/client';
import {
  commitRename,
  loadAllFiles,
  loadHistory,
  replaceWorkspace,
  saveFile,
  undoOperation,
  type OperationLog,
} from '../storage/db';
import { scenarios, type Scenario } from '../scenarios/index';
import type { AnalyzeResult, RenameItem, SelfCheckResult } from '../shared/protocol';
import type { FileState, PreviewState } from './types';
import { itemKey } from './types';
import { buildCommit, detectDrift, snapshotOf, verifyBaselines } from './commit';

type RightTab = 'preview' | 'history' | 'selftest';

export default function App() {
  const [files, setFiles] = useState<FileState[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [cursor, setCursor] = useState<{ file: string; pos: number; word: string | null } | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [history, setHistory] = useState<OperationLog[]>([]);
  const [tab, setTab] = useState<RightTab>('preview');
  const [analyzing, setAnalyzing] = useState(false);
  const [selfcheck, setSelfcheck] = useState<SelfCheckResult | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const filesRef = useRef<FileState[]>(files);
  filesRef.current = files;
  const previewRef = useRef<PreviewState | null>(preview);
  previewRef.current = preview;
  const revealRef = useRef<(file: string, offset: number) => void>(() => {});
  const analyzeSeq = useRef(0);

  // 启动：从 IndexedDB 恢复；无工程则载入“变量遮蔽”验证场景
  useEffect(() => {
    (async () => {
      const stored = await loadAllFiles();
      if (stored.length > 0) {
        setFiles(stored.map((f) => ({ path: f.path, content: f.content, rev: f.rev })));
        setActivePath(stored[0].path);
      } else {
        await loadScenario(scenarios[0]);
      }
      setHistory(await loadHistory());
      setLoaded(true);
    })();
  }, []);

  const activeFile = useMemo(() => files.find((f) => f.path === activePath) ?? null, [files, activePath]);

  const refreshHistory = useCallback(async () => setHistory(await loadHistory()), []);

  const loadScenario = useCallback(async (s: Scenario) => {
    const next = s.files.map((f) => ({ path: f.path, content: f.content, rev: 1 }));
    await replaceWorkspace(
      s.files.map((f) => ({ path: f.path, content: f.content })),
    );
    setFiles(next);
    setActivePath(s.cursor.file);
    setPreview(null);
    setHistory([]);
    setTab('preview');
    // 载入后把编辑器光标定位到建议标识符（模型就绪后由待定位队列消费），用户直接按 F2
    const target = s.files.find((f) => f.path === s.cursor.file);
    if (target) {
      const off = offsetOf(target.content, s.cursor.identifier, s.cursor.occurrence ?? 1);
      setCursor({ file: s.cursor.file, pos: off, word: s.cursor.identifier });
      revealRef.current(s.cursor.file, off);
    }
  }, []);

  // 编辑器内容变更：立即存 IDB（草稿绝不丢失），rev+1，并检测预览过期
  const handleEdit = useCallback((path: string, content: string) => {
    setFiles((prev) => {
      const next = prev.map((f) => (f.path === path ? { ...f, content, rev: f.rev + 1 } : f));
      // 异步持久化，不阻塞输入
      const rev = (prev.find((f) => f.path === path)?.rev ?? 0) + 1;
      void saveFile(path, content, rev);
      const p = previewRef.current;
      if (p) {
        const drifted = detectDrift(next, p.snapshot).concat(
          next.length !== Object.keys(p.snapshot).length ? ['（文件集合发生变化）'] : [],
        );
        if (drifted.length > 0 && !p.stale) {
          setPreview({ ...p, stale: true, staleFiles: drifted });
        }
      }
      return next;
    });
  }, []);

  const runAnalyze = useCallback(
    async (file: string, pos: number) => {
      const seq = ++analyzeSeq.current;
      setAnalyzing(true);
      try {
        const snapshotBefore = filesRef.current;
        const result: AnalyzeResult = await tsWorker.analyze(
          snapshotBefore.map((f) => ({ path: f.path, content: f.content, rev: f.rev })),
          file,
          pos,
        );
        if (seq !== analyzeSeq.current) return; // 已被更新的分析取代
        // Worker 返回期间文件可能已被再次编辑：立即做共同版本复核
        const snap = snapshotOf(snapshotBefore);
        const driftedNow = detectDrift(filesRef.current, snap);
        const selected: Record<string, boolean> = {};
        for (const it of result.items) {
          if (it.status !== 'excluded') selected[itemKey(it)] = it.defaultSelected;
        }
        setPreview({
          result,
          snapshot: snap,
          newName: result.ok ? result.oldName : '',
          selected,
          loading: false,
          stale: driftedNow.length > 0,
          staleFiles: driftedNow,
        });
        setTab('preview');
      } catch (err) {
        setToast(`分析失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (seq === analyzeSeq.current) setAnalyzing(false);
      }
    },
    [],
  );

  // 光标停在标识符上时由快捷键/按钮发起；分析期间继续编辑也不受阻（编辑后自动标记过期）
  const handleRenameAtCursor = useCallback(() => {
    if (!cursor) {
      setToast('请先把光标放在要重命名的标识符上');
      return;
    }
    void runAnalyze(cursor.file, cursor.pos);
  }, [cursor, runAnalyze]);

  const reanalyze = useCallback(() => {
    const p = previewRef.current;
    if (!p) return;
    void runAnalyze(p.result.triggerFile, p.result.triggerPos);
  }, [runAnalyze]);

  // 跨文件/同文件统一入口：先切换激活文件，再用 EditorPane 的待定位队列完成跳转
  const openAndReveal = useCallback((file: string, offset: number) => {
    revealRef.current(file, offset); // EditorPane 在目标模型就绪后自动消费
    setActivePath(file);
  }, []);

  const toggleItem = useCallback((key: string) => {
    setPreview((p) => {
      if (!p) return p;
      const item = p.result.items.find((i) => itemKey(i) === key);
      if (!item || item.status === 'excluded') return p;
      const cur = p.selected[key] ?? item.defaultSelected;
      return { ...p, selected: { ...p.selected, [key]: !cur } };
    });
  }, []);

  const toggleGroup = useCallback((items: RenameItemLike[], on: boolean) => {
    setPreview((p) => {
      if (!p) return p;
      const selected = { ...p.selected };
      for (const i of items) {
        if (i.status !== 'excluded') selected[itemKey(i)] = on;
      }
      return { ...p, selected };
    });
  }, []);

  const handleCommit = useCallback(async () => {
    const p = previewRef.current;
    if (!p || !p.result.ok || p.stale) return;
    // 提交前复核共同版本
    const check = verifyBaselines(filesRef.current, p.result.baselines);
    if (!check.ok) {
      setPreview({ ...p, stale: true, staleFiles: check.drifted });
      setToast('文件已在分析后变化，已锁定提交，请重新分析。');
      return;
    }
    const committed = buildCommit(filesRef.current, p.result, p.selected, p.newName);
    if (committed === null) {
      setToast('存在重叠的编辑区间，已阻止提交（未做任何替换）。');
      return;
    }
    const before = committed.map((c) => {
      const f = filesRef.current.find((x) => x.path === c.path)!;
      return { path: c.path, content: f.content, rev: f.rev };
    });
    const chosenCount = committed.reduce((n, c) => n + c.count, 0);
    await commitRename({
      changes: committed.map((c) => ({ path: c.path, content: c.content, rev: c.rev })),
      before,
      oldName: p.result.oldName,
      newName: p.newName,
      changedCount: chosenCount,
    });
    setFiles((prev) =>
      prev.map((f) => {
        const c = committed.find((x) => x.path === f.path);
        return c ? { ...f, content: c.content, rev: c.rev } : f;
      }),
    );
    await refreshHistory();
    setPreview(null);
    setTab('history');
    setToast(`已提交 ${chosenCount} 处改动，覆盖 ${committed.length} 个文件。可在“操作历史”按整次操作撤销。`);
  }, [refreshHistory]);

  const handleUndo = useCallback(
    async (log: OperationLog) => {
      const restored = await undoOperation(log);
      setFiles((prev) => {
        const next = [...prev];
        for (const r of restored) {
          const idx = next.findIndex((f) => f.path === r.path);
          if (idx >= 0) next[idx] = { path: r.path, content: r.content, rev: r.rev };
          else next.push({ path: r.path, content: r.content, rev: r.rev });
        }
        return next;
      });
      // 撤销后任何基于旧内容的预览都失效
      setPreview((p) => (p ? { ...p, stale: true, staleFiles: restored.map((r) => r.path) } : p));
      await refreshHistory();
      setToast(`已撤销整次操作：${log.label}`);
    },
    [refreshHistory],
  );

  const runSelfCheck = useCallback(async () => {
    const r = await tsWorker.selfcheck();
    setSelfcheck(r);
  }, []);

  // 键盘：F2 / Ctrl+R(Cmd+R 保留给浏览器，用 Alt+R) 发起重命名
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault();
        handleRenameAtCursor();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleRenameAtCursor]);

  if (!loaded) return <div className="boot">正在打开本地工程…</div>;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">重命名预览 <span className="brand-sub">逐处确认 · 符号绑定 · 纯本地</span></div>
        <div className="scenarios">
          <span className="top-label">验证工程：</span>
          {scenarios.map((s) => (
            <button key={s.id} className="scenario-btn" title={s.description} onClick={() => void loadScenario(s)}>
              {s.name}
            </button>
          ))}
        </div>
        <div className="top-actions">
          <button className="btn btn-primary" disabled={analyzing} onClick={handleRenameAtCursor}>
            {analyzing ? '分析中…' : '重命名光标处符号 (F2)'}
          </button>
        </div>
      </header>
      <div className="body">
        <aside className="sidebar">
          <div className="sidebar-title">文件（{files.length}）</div>
          <ul className="file-list">
            {files.map((f) => (
              <li key={f.path}>
                <button
                  className={`file-row ${f.path === activePath ? 'active' : ''}`}
                  onClick={() => {
                    setActivePath(f.path);
                  }}
                >
                  <span className="file-name">{f.path.split('/').pop()}</span>
                  <span className="file-path">{f.path}</span>
                  <span className="file-rev">rev {f.rev}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="sidebar-foot">
            <div className="storage-note">文件与操作历史保存在浏览器 IndexedDB；不运行导入代码、不访问后端。</div>
          </div>
        </aside>

        <main className="main">
          <EditorPane
            file={activeFile}
            preview={preview}
            onEdit={handleEdit}
            onCursorSymbol={(file, pos, word) => setCursor({ file, pos, word })}
            registerReveal={(fn) => {
              revealRef.current = fn;
            }}
          />
          <div className="cursor-hint">
            {cursor?.word ? (
              <>
                光标符号：<code>{cursor.word}</code> · {cursor.file}:{cursor.pos} · 按 <b>F2</b> 发起重命名
              </>
            ) : (
              <>把光标放到标识符上，按 <b>F2</b> 生成逐处确认的预览</>
            )}
          </div>
        </main>

        <aside className="rightbar">
          <nav className="tabs">
            <button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>
              重命名预览
            </button>
            <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
              操作历史 ({history.length})
            </button>
            <button className={tab === 'selftest' ? 'active' : ''} onClick={() => setTab('selftest')}>
              工程自测
            </button>
          </nav>
          <div className="tab-body">
            {tab === 'preview' &&
              (preview ? (
                <PreviewPanel
                  preview={preview}
                  onNewName={(name) => setPreview((p) => (p ? { ...p, newName: name } : p))}
                  onToggle={toggleItem}
                  onToggleGroup={toggleGroup}
                  onCommit={() => void handleCommit()}
                  onDiscard={() => setPreview(null)}
                  onReanalyze={reanalyze}
                  onReveal={(file, offset) => openAndReveal(file, offset)}
                />
              ) : (
                <div className="empty-preview">
                  <p>本工具不会做盲目全文替换。</p>
                  <ol>
                    <li>把光标放在标识符上，按 F2；</li>
                    <li>Worker 内的 TypeScript Compiler API 按<b>符号绑定</b>计算全部位置；</li>
                    <li>逐处勾选：
                      <span className="legend">
                        <i className="dot dot-proven" /> 已证明
                        <i className="dot dot-string" /> 需人工判断
                        <i className="dot dot-excluded" /> 同名不同绑定
                      </span>
                    </li>
                    <li>提交前复核共同版本；撤销按整次操作恢复。</li>
                  </ol>
                  <p className="dim">试试顶部“变量遮蔽”“类型与值同名”等验证工程，并在分析进行时继续打字以观察过期保护。</p>
                </div>
              ))}
            {tab === 'history' && <HistoryPanel history={history} onUndo={(log) => void handleUndo(log)} />}
            {tab === 'selftest' && (
              <div className="selftest">
                <p className="dim">同一套分析引擎同时在 Worker 与 Node 自测中运行，验证遮蔽、类型/值同名、动态访问、语法错误、格式保留与版本漂移。</p>
                <button className="btn btn-primary" onClick={() => void runSelfCheck()}>
                  在 Worker 中运行自测
                </button>
                {selfcheck && (
                  <ul className="check-list">
                    {selfcheck.checks.map((c, i) => (
                      <li key={i} className={c.pass ? 'check pass' : 'check fail'}>
                        <span className="check-mark">{c.pass ? 'PASS' : 'FAIL'}</span>
                        <div>
                          <div className="check-name">{c.name}</div>
                          <div className="check-detail">{c.detail}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>
      {toast && (
        <div className="toast" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  );
}

type RenameItemLike = RenameItem;

function offsetOf(content: string, identifier: string, occurrence: number): number {
  let at = -1;
  for (let i = 0; i < occurrence; i++) {
    at = content.indexOf(identifier, at + 1);
    if (at < 0) return Math.max(0, content.indexOf(identifier));
  }
  return at;
}
