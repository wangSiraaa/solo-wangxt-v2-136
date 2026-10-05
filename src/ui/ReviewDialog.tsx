import { useMemo, useState } from 'react';
import type { StudioApi } from '../state/studio';
import { diffLines, type DiffLine } from '../engine/edit';
import type { CommitOutcome } from '../state/studio';

export function ReviewDialog({
  studio,
  onClose,
  onCommitted,
}: {
  studio: StudioApi;
  onClose: () => void;
  onCommitted: (out: CommitOutcome) => void;
}) {
  const { session, gate, previewEdits } = studio;
  const [busy, setBusy] = useState(false);

  const fileDiffs = useMemo(() => {
    if (!session) return [];
    const selectedByFile = new Map<string, number>();
    for (const o of gate?.selected ?? []) {
      selectedByFile.set(o.fileName, (selectedByFile.get(o.fileName) ?? 0) + 1);
    }
    const dynByFile = new Map<string, number>();
    for (const o of session.result.occurrences.filter(
      (x) => x.kind === 'dynamic',
    )) {
      dynByFile.set(o.fileName, (dynByFile.get(o.fileName) ?? 0) + 1);
    }
    return [...previewEdits.entries()]
      .map(([path, fe]) => {
        const newText = applyPreview(fe);
        return {
          path,
          oldText: fe.oldContent,
          newText,
          diff: diffLines(fe.oldContent, newText),
          provenCount: selectedByFile.get(path) ?? 0,
          dynamicCount: dynByFile.get(path) ?? 0,
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path));
  }, [session, gate, previewEdits]);

  if (!session || !gate?.ok) return null;

  const unchangedFiles = useMemo(
    () =>
      [...new Set(session.result.occurrences.map((o) => o.fileName))].filter(
        (p) => !previewEdits.has(p),
      ),
    [session, previewEdits],
  );

  const commonVersionLines = Object.entries(session.result.analyzedVersions);
  const staleNow = commonVersionLines.filter(
    ([p, v]) => studio.docs[p]?.version !== v,
  );

  const doCommit = async () => {
    if (busy) return;
    setBusy(true);
    const out = await studio.commit();
    setBusy(false);
    if (out) {
      onCommitted(out);
    } else {
      onClose();
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-head">
          提交前复核
          <button className="btn tiny" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-scroll">
          <section className="review-section">
            <h3>1. 操作内容</h3>
            <p>
              将 <code>{session.result.oldName}</code> 重命名为{' '}
              <code>{session.newName}</code>，一次操作原子提交、可整次撤销。
            </p>
          </section>

          <section className="review-section">
            <h3>2. 共同版本（分析基线 vs 当前草稿）</h3>
            {staleNow.length === 0 ? (
              <div className="block-ok">
                ✅ {commonVersionLines.length} 个文件的当前内容与分析时完全一致，
                所有偏移仍然有效。
              </div>
            ) : (
              <div className="block-error">
                ⛔ 分析之后又有 {staleNow.length} 个文件被修改，
                请关闭本窗口重新分析。
                <ul>
                  {staleNow.map(([p]) => (
                    <li key={p}>
                      <code>{p}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section className="review-section">
            <h3>3. 逐文件差异</h3>
            <p className="small muted">
              仅显示“已证明”的替换；注释、其它绑定、未勾选位置逐字保留，
              无关格式不变。
            </p>
            {fileDiffs.map((fd) => (
              <div key={fd.path} className="file-diff">
                <div className="file-diff-head">
                  <code>{fd.path}</code>
                  <span className="badge proven">
                    {fd.provenCount} 处已证明替换
                  </span>
                  {fd.dynamicCount > 0 && (
                    <span className="badge dynamic">
                      {fd.dynamicCount} 处动态访问由你人工处理（不改）
                    </span>
                  )}
                </div>
                <DiffView diff={fd.diff} />
              </div>
            ))}
            {fileDiffs.length === 0 && (
              <div className="block-warn">没有选择任何替换。</div>
            )}
            {unchangedFiles.length > 0 && (
              <div className="small muted">
                以下文件出现在分析中但本次不会被写入：
                {unchangedFiles.map((p) => (
                  <code key={p} className="chip">
                    {p}
                  </code>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={onClose}>
            返回调整
          </button>
          <button
            className="btn primary"
            disabled={staleNow.length > 0 || busy}
            onClick={() => void doCommit()}
          >
            {busy ? '提交中…' : '确认提交（整次操作可撤销）'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DiffView({ diff }: { diff: DiffLine[] }) {
  return (
    <div className="diff-view">
      {diff.map((l, i) => (
        <div key={i} className={`diff-line ${l.kind}`}>
          <span className="gutter">{l.oldNo || ''}</span>
          <span className="gutter">{l.newNo || ''}</span>
          <span className="sign">
            {l.kind === 'equal' ? ' ' : l.kind === 'delete' ? '-' : '+'}
          </span>
          <span className="diff-text">{l.text || ' '}</span>
        </div>
      ))}
    </div>
  );
}

function applyPreview(fe: {
  oldContent: string;
  edits: { start: number; length: number; newText: string }[];
}): string {
  const sorted = [...fe.edits].sort((a, b) => b.start - a.start);
  let out = fe.oldContent;
  for (const e of sorted) {
    out = out.slice(0, e.start) + e.newText + out.slice(e.start + e.length);
  }
  return out;
}
