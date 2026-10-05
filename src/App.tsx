import { useRef, useState } from 'react';
import type * as MonacoNS from 'monaco-editor';
import { useStudio, type CommitOutcome } from './state/studio';
import { Sidebar } from './ui/Sidebar';
import { EditorPane } from './ui/EditorPane';
import { RenamePanel } from './ui/RenamePanel';
import { ReviewDialog } from './ui/ReviewDialog';

interface EditorHandle {
  monaco: typeof MonacoNS;
  editor: MonacoNS.editor.IStandaloneCodeEditor;
}

export default function App() {
  const editorHandle = useRef<EditorHandle | null>(null);
  const studio = useStudio(editorHandle);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reveal, setReveal] = useState<{ path: string; offset: number } | null>(
    null,
  );

  const onCommitted = (out: CommitOutcome) => {
    setReviewOpen(false);
    studio.flashNotice(
      `已提交：${out.replacedCount} 处替换，涉及 ${out.changedFiles.length} 个文件；可在“历史”中整次撤销。`,
    );
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Rename Studio <span className="sub">逐处确认的 TypeScript 重命名预览</span>
        </div>
        <div className="topbar-meta">
          TypeScript Compiler API @ Web Worker · IndexedDB 本地存储 ·
          不执行工程代码 · 无后端
        </div>
      </header>
      <div className="layout">
        <Sidebar studio={studio} />
        <main className="center">
          {studio.loaded ? (
            <EditorPane
              studio={studio}
              onHandle={(h) => {
                editorHandle.current = h;
              }}
              reveal={reveal}
            />
          ) : (
            <div className="loading">正在加载 IndexedDB 中的工程并启动分析 Worker…</div>
          )}
        </main>
        <section className="right">
          {studio.session ? (
            <RenamePanel
              studio={studio}
              onReveal={(path, offset) => setReveal({ path, offset })}
              onReview={() => setReviewOpen(true)}
            />
          ) : (
            <EmptyState />
          )}
        </section>
      </div>
      {studio.notice && <div className="toast">{studio.notice}</div>}
      {reviewOpen && (
        <ReviewDialog
          studio={studio}
          onClose={() => setReviewOpen(false)}
          onCommitted={onCommitted}
        />
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="panel empty-state">
      <h2>开始一次重命名分析</h2>
      <ol>
        <li>把光标放到任意标识符上</li>
        <li>
          点击 <em>“分析光标处的重命名”</em>，或按{' '}
          <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>
        </li>
        <li>
          在右侧逐处确认：<span className="ok">已证明</span>可勾选替换，
          <span className="warn">同名其它绑定 / 字符串</span>需人工判断，
          <span className="bad">动态访问</span>列为未覆盖位置，
          <span className="muted">注释</span>默认保留。
        </li>
        <li>复核共同版本与差异后，整次提交；可在历史中整次撤销。</li>
      </ol>
      <p className="small muted">
        左侧“验证指引”页列出了遮蔽、类型/值同名、分析期间编辑等验证步骤。
      </p>
    </div>
  );
}
