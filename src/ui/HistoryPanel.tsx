import type { OperationLog } from '../storage/db';

interface HistoryPanelProps {
  history: OperationLog[];
  onUndo: (log: OperationLog) => void;
}

export function HistoryPanel({ history, onUndo }: HistoryPanelProps) {
  if (history.length === 0) {
    return (
      <div className="history-empty">
        尚无已提交操作。提交一次跨文件重命名后，可按<b>整次操作</b>一键撤销。
      </div>
    );
  }
  return (
    <ul className="history-list">
      {[...history].reverse().map((h) => (
        <li key={h.id} className="history-item">
          <div className="history-label">{h.label}</div>
          <div className="history-meta">
            {new Date(h.at).toLocaleString()} · 恢复 {h.before.length} 个文件的操作前快照
          </div>
          <button className="btn btn-small" onClick={() => onUndo(h)}>
            撤销整次操作
          </button>
        </li>
      ))}
    </ul>
  );
}
