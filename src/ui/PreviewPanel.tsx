import type { AnalyzeResult, RenameItem } from '../shared/protocol';
import { itemKey, type PreviewState } from './types';

interface PreviewPanelProps {
  preview: PreviewState;
  onNewName: (name: string) => void;
  onToggle: (key: string) => void;
  onToggleGroup: (items: RenameItem[], on: boolean) => void;
  onCommit: () => void;
  onDiscard: () => void;
  onReanalyze: () => void;
  onReveal: (file: string, offset: number) => void;
}

type Group = {
  title: string;
  badge: string;
  items: RenameItem[];
  tone: 'proven' | 'string' | 'excluded';
};

function groupItems(result: AnalyzeResult): Group[] {
  const proven: RenameItem[] = [];
  const string: RenameItem[] = [];
  const excluded: RenameItem[] = [];
  for (const i of result.items) {
    if (i.status === 'excluded') excluded.push(i);
    else if (i.status === 'string') string.push(i);
    else proven.push(i);
  }
  return [
    {
      title: '已证明的改动',
      badge: `编译器可证明属于目标符号，按符号绑定定位`,
      items: proven,
      tone: 'proven',
    },
    {
      title: '需人工判断',
      badge: `字符串键 / 动态访问 / 类型不可解析，默认不改`,
      items: string,
      tone: 'string',
    },
    {
      title: '同名不同绑定 · 已排除',
      badge: `名字相同但作用域或绑定不同，绝不修改`,
      items: excluded,
      tone: 'excluded',
    },
  ];
}

export function PreviewPanel(props: PreviewPanelProps) {
  const { preview, onNewName, onToggle, onToggleGroup, onCommit, onDiscard, onReanalyze, onReveal } = props;
  const { result } = preview;

  if (!result.ok) {
    return (
      <div className="panel">
        <div className="blocked">
          <div className="blocked-title">无法生成重命名预览</div>
          <div className="blocked-reason">{result.blockReason}</div>
          {result.syntaxErrors.length > 0 && (
            <div className="error-list">
              {result.syntaxErrors.map((e, idx) => (
                <button
                  key={idx}
                  className="error-row"
                  onClick={() => onReveal(e.file, e.start)}
                >
                  <span className="error-file">{e.file}</span>
                  <span className="error-pos">
                    {e.startLine}:{e.startCol}
                  </span>
                  <span className="error-msg">{e.message}</span>
                </button>
              ))}
            </div>
          )}
          <div className="hint">草稿已原样保留，未做任何替换。修复后把光标放回标识符再发起重命名。</div>
          <button className="btn" onClick={onDiscard}>
            关闭
          </button>
        </div>
      </div>
    );
  }

  const groups = groupItems(result);
  const selectable = result.items.filter((i) => i.status !== 'excluded');
  const chosen = selectable.filter((i) => preview.selected[itemKey(i)] ?? i.defaultSelected);
  const filesTouched = new Set(chosen.map((i) => i.file));
  const validName = /^[A-Za-z_$][\w$]*$/.test(preview.newName) && preview.newName !== result.oldName;

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="rename-title">
          重命名预览 <code>{result.oldName}</code>
          <span className="arrow">→</span>
          <input
            className="name-input"
            value={preview.newName}
            onChange={(e) => onNewName(e.target.value)}
            placeholder="新名称"
            spellCheck={false}
            autoFocus
          />
        </div>
        <div className="symbol-meta">
          <span className="chip chip-kind">{displayName(result)}</span>
          <span className="chip">触发于 {shortFile(result.triggerFile)}</span>
        </div>
      </div>

      {preview.stale && (
        <div className="stale-banner">
          <strong>预览已过期：</strong>分析期间以下文件被再次编辑 —— {preview.staleFiles.join('、')}。
          旧偏移可能指向错误位置，提交已被锁定。
          <button className="btn btn-warn" onClick={onReanalyze}>
            基于当前共同版本重新分析
          </button>
        </div>
      )}

      {result.syntaxErrors.length > 0 && !preview.stale && (
        <div className="warn-banner">
          工程中存在 {result.syntaxErrors.length} 个语法错误；错误文件中的语义结果已降级为“需人工判断”。
        </div>
      )}

      <div className="summary">
        本次将改动 <b className="n-proven">{chosen.length}</b> 处，覆盖 <b>{filesTouched.size}</b> 个文件；
        另有 <b className="n-string">{groups[1].items.length}</b> 处需人工判断、
        <b className="n-excluded"> {groups[2].items.length}</b> 处同名异绑定已排除。
      </div>

      <div className="groups">
        {groups.map((g) => (
          <GroupView
            key={g.tone}
            g={g}
            selected={preview.selected}
            onToggle={onToggle}
            onToggleGroup={onToggleGroup}
            onReveal={onReveal}
          />
        ))}
      </div>

      <div className="baseline">
        提交前复核共同版本：
        {Object.entries(result.baselines).map(([f, b]) => (
          <span key={f} className="baseline-item">
            {shortFile(f)} <code>rev {b.rev}</code>
          </span>
        ))}
      </div>

      <div className="actions">
        <button className="btn btn-primary" disabled={!validName || preview.stale || chosen.length === 0} onClick={onCommit}>
          提交 {chosen.length > 0 ? `${chosen.length} 处改动` : ''}
        </button>
        <button className="btn" onClick={onDiscard}>
          放弃预览
        </button>
        {!preview.newName.match(/^[A-Za-z_$][\w$]*$/) && preview.newName.length > 0 && (
          <span className="invalid-name">名称需为合法标识符</span>
        )}
        {preview.newName === result.oldName && <span className="invalid-name">新名称与原名相同</span>}
      </div>
    </div>
  );
}

function displayName(result: AnalyzeResult): string {
  return result.displayName || result.oldName;
}

function shortFile(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1];
}

function GroupView({
  g,
  selected,
  onToggle,
  onToggleGroup,
  onReveal,
}: {
  g: Group;
  selected: Record<string, boolean>;
  onToggle: (key: string) => void;
  onToggleGroup: (items: RenameItem[], on: boolean) => void;
  onReveal: (file: string, offset: number) => void;
}) {
  if (g.items.length === 0) return null;
  const allOn = g.items.every((i) => (i.status === 'excluded' ? false : selected[itemKey(i)] ?? i.defaultSelected));
  return (
    <section className={`group group-${g.tone}`}>
      <header className="group-head">
        <span className="group-title">{g.title}</span>
        <span className="group-count">{g.items.length}</span>
        <span className="group-badge">{g.badge}</span>
        {g.tone !== 'excluded' && (
          <span className="group-actions">
            <button className="link-btn" onClick={() => onToggleGroup(g.items, true)}>
              全选
            </button>
            <button className="link-btn" onClick={() => onToggleGroup(g.items, false)}>
              全不选
            </button>
            {!allOn && g.tone === 'proven' && <em className="dim">（有已证明项被手动取消）</em>}
          </span>
        )}
      </header>
      <ul className="item-list">
        {g.items.map((i) => {
          const key = itemKey(i);
          const on = selected[key] ?? i.defaultSelected;
          return (
            <li key={key} className={`item item-${i.status} ${on ? 'is-on' : ''}`}>
              {i.status === 'excluded' ? (
                <span className="item-check fixed">✕</span>
              ) : (
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => onToggle(key)}
                  title={on ? '点击取消该改动' : '点击纳入该改动'}
                />
              )}
              <button
                className="item-loc"
                onClick={() => onReveal(i.file, i.start)}
                title="跳转到该位置"
              >
                <span className="loc-file">{shortFile(i.file)}</span>
                <span className="loc-pos">
                  {i.startLine}:{i.startCol}
                </span>
                <code className="loc-snippet">{i.snippet}</code>
              </button>
              <span className="item-kind">{kindText(i.kind)}</span>
              <span className="item-note">{i.status === 'excluded' ? i.excludedReason : i.uncertainty ?? i.scope}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function kindText(kind: RenameItem['kind']): string {
  switch (kind) {
    case 'local-variable':
      return '局部变量';
    case 'property':
      return '属性';
    case 'type':
      return '类型';
    case 'function':
      return '函数';
    default:
      return '值';
  }
}
