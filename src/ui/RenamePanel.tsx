import { useMemo } from 'react';
import type { StudioApi } from '../state/studio';
import type {
  OccurrenceKind,
  RenameOccurrence,
  RenameAnalysisResult,
} from '../engine/types';

const KIND_META: Record<
  OccurrenceKind,
  { label: string; badge: string; desc: string }
> = {
  proven: {
    label: '已证明',
    badge: 'badge proven',
    desc: 'TypeScript 符号绑定确认属于目标符号',
  },
  otherBinding: {
    label: '同名·其它绑定',
    badge: 'badge other',
    desc: '同名文本但绑定到另一个符号：变量遮蔽 / 类型与值同名 / 无关属性',
  },
  stringText: {
    label: '字符串文本',
    badge: 'badge string',
    desc: '字符串/JSX 文本中的同名片段，无法从绑定判断，需逐处人工确认',
  },
  dynamic: {
    label: '未覆盖·动态访问',
    badge: 'badge dynamic',
    desc: '动态访问无法静态证明是否指向目标属性，提交前必须逐条确认已人工处理',
  },
  comment: {
    label: '注释',
    badge: 'badge comment',
    desc: '注释中的同名文本，默认保留不动',
  },
};

const ORDER: OccurrenceKind[] = [
  'proven',
  'otherBinding',
  'stringText',
  'dynamic',
  'comment',
];

export function RenamePanel({
  studio,
  onReveal,
  onReview,
}: {
  studio: StudioApi;
  onReveal: (path: string, offset: number) => void;
  onReview: () => void;
}) {
  const { session } = studio;
  if (!session) return null;
  const r = session.result;

  if (r.status === 'syntaxError') {
    return <SyntaxBlock studio={studio} />;
  }
  if (r.status === 'cannotRename' || r.status === 'notIdentifier') {
    return (
      <div className="panel">
        <div className="panel-head">无法重命名</div>
        <div className="block-error">
          {r.cannotRenameReason ?? '光标位置不是可重命名的标识符。'}
        </div>
        <button className="btn" onClick={studio.cancelSession}>
          返回
        </button>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-head">
        重命名预览
        <button className="btn tiny" onClick={studio.cancelSession}>
          ✕ 取消
        </button>
      </div>

      <TargetSummary r={r} />

      <div className="rename-input">
        <label>
          旧名称
          <input value={r.oldName} disabled />
        </label>
        <label>
          新名称
          <input
            value={session.newName}
            onChange={(e) => studio.setNewName(e.target.value)}
            placeholder="输入新标识符"
            autoFocus
          />
        </label>
        {!studio.isValidNewName(session.newName) && (
          <div className="text-error">新名称不是合法标识符。</div>
        )}
      </div>

      <OccurrenceSections studio={studio} onReveal={onReveal} />

      <div className="panel-foot">
        <GateMessages studio={studio} />
        <button
          className="btn primary wide"
          disabled={!studio.gate?.ok}
          onClick={onReview}
        >
          复核并准备提交…
        </button>
        {!studio.gate?.ok && (
          <div className="text-error small">
            上方问题全部解决后才能进入提交复核。
          </div>
        )}
      </div>
    </div>
  );
}

function TargetSummary({ r }: { r: RenameAnalysisResult }) {
  return (
    <div className="target-summary">
      <div>
        <span className="badge proven">{r.targetKindLabel ?? '符号'}</span>
        <strong>{r.targetLabel}</strong>
      </div>
      <div className="small muted">
        触发：{r.triggerFileName} · 偏移 {r.triggerPosition}
      </div>
    </div>
  );
}

function SyntaxBlock({ studio }: { studio: StudioApi }) {
  const r = studio.session!.result;
  return (
    <div className="panel">
      <div className="panel-head">发现语法错误</div>
      <div className="block-error">
        目标文件或其导入闭包存在语法错误，分析已中止。<br />
        <strong>编辑器草稿已原样保留</strong>，不会做任何替换；
        请修复后重新分析。
      </div>
      <div className="occ-list">
        {r.blockingSyntax.map((s, i) => (
          <div
            key={i}
            className="occ-row clickable"
            onClick={() => {
              studio.setActivePath(s.fileName);
            }}
          >
            <span className="badge dynamic">阻断</span>
            <code>
              {s.fileName}:{s.line}
            </code>
            <div className="snippet">{s.message}</div>
          </div>
        ))}
      </div>
      <button className="btn" onClick={studio.cancelSession}>
        返回
      </button>
    </div>
  );
}

function OccurrenceSections({
  studio,
  onReveal,
}: {
  studio: StudioApi;
  onReveal: (path: string, offset: number) => void;
}) {
  const { session, gate } = studio;
  const r = session!.result;

  const grouped = useMemo(() => {
    const m = new Map<OccurrenceKind, RenameOccurrence[]>();
    for (const kind of ORDER) m.set(kind, []);
    for (const o of r.occurrences) m.get(o.kind)!.push(o);
    return m;
  }, [r]);

  const provenList = grouped.get('proven')!;
  const allSelected =
    provenList.length > 0 && provenList.every((o) => session!.selected.has(o.id));

  return (
    <div className="panel-body">
      <div className="legend">
        {ORDER.map((k) => (
          <span key={k} className="legend-item">
            <i className={`dot ${k}`} />
            {KIND_META[k].label}
          </span>
        ))}
      </div>

      {/* 过期警告（分析期间再次编辑） */}
      {gate?.staleFiles.length ? (
        <div className="block-warn">
          ⚠️ 预览已过期：分析之后以下文件又被修改，提交已锁定：
          <ul>
            {gate.staleFiles.map((f) => (
              <li key={f.path}>
                <code>{f.path}</code>
              </li>
            ))}
          </ul>
          <div className="small">请重新分析以对齐“共同版本”。</div>
        </div>
      ) : null}

      {ORDER.map((kind) => {
        const list = grouped.get(kind)!;
        if (list.length === 0) return null;
        const meta = KIND_META[kind];
        return (
          <section key={kind} className={`occ-section ${kind}`}>
            <header>
              <span className={meta.badge}>{meta.label}</span>
              <span className="count">{list.length}</span>
              {kind === 'proven' && (
                <label className="select-all">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={(e) =>
                      studio.toggleSelectAllProven(e.target.checked)
                    }
                  />
                  全选
                </label>
              )}
            </header>
            <p className="section-desc">{meta.desc}</p>
            <div className="occ-list">
              {list.map((o) => (
                <OccurrenceRow
                  key={o.id}
                  kind={kind}
                  o={o}
                  studio={studio}
                  onReveal={onReveal}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function OccurrenceRow({
  kind,
  o,
  studio,
  onReveal,
}: {
  kind: OccurrenceKind;
  o: RenameOccurrence;
  studio: StudioApi;
  onReveal: (path: string, offset: number) => void;
}) {
  const { session } = studio;
  const checked =
    kind === 'proven'
      ? session!.selected.has(o.id)
      : kind === 'dynamic'
        ? session!.dynamicChecked.has(o.id)
        : false;

  return (
    <div className={`occ-row kind-${kind}`}>
      {kind === 'proven' ? (
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => studio.toggleOccurrence(o.id, e.target.checked)}
          title="只允许勾选已证明的命中"
        />
      ) : kind === 'dynamic' ? (
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => studio.toggleDynamicChecked(o.id, e.target.checked)}
          title="勾选表示我已人工处理该动态访问"
        />
      ) : (
        <span className="no-check" title="此类位置不能自动替换" />
      )}
      <div
        className="occ-main clickable"
        onClick={() => {
          studio.setActivePath(o.fileName);
          onReveal(o.fileName, o.start);
        }}
      >
        <div className="occ-loc">
          <code>
            {o.fileName}:{o.line}
          </code>
          {o.isDeclaration && <span className="badge decl">声明</span>}
        </div>
        <pre className="snippet">
          <SnippetHighlight o={o} />
        </pre>
        {o.symbolLabel && (
          <div className="small muted">绑定：{o.symbolLabel}</div>
        )}
        {o.note && <div className="small note">{o.note}</div>}
      </div>
    </div>
  );
}

function SnippetHighlight({ o }: { o: RenameOccurrence }) {
  const text = o.snippetText;
  const col = o.startCharacter;
  const len = o.length || 0;
  return (
    <>
      {text.slice(0, col)}
      <em className={`hl ${o.kind}`}>
        {text.slice(col, col + len) || '▸'}
      </em>
      {text.slice(col + len)}
    </>
  );
}

function GateMessages({ studio }: { studio: StudioApi }) {
  const issues = studio.gate?.issues ?? [];
  if (issues.length === 0) {
    const n = studio.gate?.selected.length ?? 0;
    const dyn =
      studio.session?.result.occurrences.filter((o) => o.kind === 'dynamic')
        .length ?? 0;
    return (
      <div className="block-ok">
        ✅ 将替换 {n} 处已证明位置；
        {dyn > 0
          ? `另有 ${dyn} 处动态访问已逐条确认由你人工处理；`
          : '无未覆盖的动态访问；'}
        注释与其它绑定保持原样。
      </div>
    );
  }
  return (
    <ul className="issue-list">
      {issues.map((i, k) => (
        <li key={k}>⛔ {i.message}</li>
      ))}
    </ul>
  );
}
