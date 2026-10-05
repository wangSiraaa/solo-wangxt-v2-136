import { useState } from 'react';
import type { StudioApi } from '../state/studio';
import type { OperationRecord } from '../state/db';

export function Sidebar({ studio }: { studio: StudioApi }) {
  const [tab, setTab] = useState<'files' | 'history' | 'help'>('files');
  const files = Object.values(studio.docs).sort((a, b) =>
    a.path.localeCompare(b.path),
  );

  return (
    <aside className="sidebar">
      <div className="tabs">
        <button
          className={tab === 'files' ? 'tab active' : 'tab'}
          onClick={() => setTab('files')}
        >
          文件
        </button>
        <button
          className={tab === 'history' ? 'tab active' : 'tab'}
          onClick={() => setTab('history')}
        >
          历史
        </button>
        <button
          className={tab === 'help' ? 'tab active' : 'tab'}
          onClick={() => setTab('help')}
        >
          验证指引
        </button>
      </div>

      {tab === 'files' && (
        <div className="file-tree">
          {files.map((f) => (
            <button
              key={f.path}
              className={
                f.path === studio.activePath ? 'file-item active' : 'file-item'
              }
              onClick={() => studio.setActivePath(f.path)}
            >
              {f.path}
            </button>
          ))}
          <NewFile studio={studio} />
          <button
            className="btn tiny reset"
            onClick={() => {
              if (
                confirm(
                  '恢复内置验证工程？当前所有文件内容将被种子版本覆盖（历史记录保留）。',
                )
              ) {
                void studio.reloadSeed();
              }
            }}
          >
            ↺ 重置为验证工程
          </button>
        </div>
      )}

      {tab === 'history' && <HistoryTab studio={studio} />}

      {tab === 'help' && <HelpTab studio={studio} />}
    </aside>
  );
}

function NewFile({ studio }: { studio: StudioApi }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  if (!open) {
    return (
      <button className="btn tiny" onClick={() => setOpen(true)}>
        ＋ 新建 .ts 文件（验证语法错误保留草稿）
      </button>
    );
  }
  return (
    <div className="new-file">
      <input
        value={name}
        placeholder="src/broken.ts"
        onChange={(e) => setName(e.target.value)}
      />
      <button
        className="btn tiny"
        onClick={() => {
          const path = name.trim() || `src/scratch-${Date.now()}.ts`;
          void studio.createScratchFile(
            path,
            '// 在这里制造语法错误，然后在另一文件发起重命名：\n// 草稿会保留，且分析会被阻断而非盲目替换。\nexport const broken = ;\n',
          );
          setOpen(false);
        }}
      >
        创建
      </button>
    </div>
  );
}

function HistoryTab({ studio }: { studio: StudioApi }) {
  if (studio.history.length === 0) {
    return (
      <div className="small muted pad">
        还没有提交过重命名操作。提交后可在此按<strong>整次操作</strong>撤销，
        所有涉及文件会一起恢复到操作前版本。
      </div>
    );
  }
  return (
    <div className="history-list">
      {studio.history.map((op) => (
        <HistoryRow key={op.id} op={op} studio={studio} />
      ))}
    </div>
  );
}

function HistoryRow({
  op,
  studio,
}: {
  op: OperationRecord;
  studio: StudioApi;
}) {
  const [confirming, setConfirming] = useState(false);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const date = new Date(op.createdAt).toLocaleString();

  return (
    <div className="history-row">
      <div className="history-label">
        <strong>{op.label}</strong>
      </div>
      <div className="small muted">{date}</div>
      <div className="small">
        {op.beforeFiles.map((f) => (
          <code key={f.path} className="chip">
            {f.path}
          </code>
        ))}
      </div>
      {!confirming ? (
        <button
          className="btn tiny"
          onClick={async () => {
            // 先展示冲突（操作后又编辑过），再让用户决定。
            const cs = op.after
              .filter(
                (a) =>
                  studio.docs[a.path] &&
                  studio.docs[a.path].version !== a.version,
              )
              .map((a) => a.path);
            setConflicts(cs);
            setConfirming(true);
          }}
        >
          ↶ 撤销整次操作
        </button>
      ) : (
        <div className="confirm-box">
          {conflicts.length > 0 ? (
            <div className="block-warn small">
              以下文件在本次操作之后又被改动，恢复将覆盖当前内容：
              {conflicts.map((p) => (
                <code key={p} className="chip">
                  {p}
                </code>
              ))}
            </div>
          ) : (
            <div className="small">确认把涉及文件整体恢复到操作前版本？</div>
          )}
          <div className="row-gap">
            <button
              className="btn tiny danger"
              onClick={() => {
                void studio.undo(op).then(() => setConfirming(false));
              }}
            >
              确认恢复
            </button>
            <button className="btn tiny" onClick={() => setConfirming(false)}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function HelpTab({ studio }: { studio: StudioApi }) {
  void studio;
  return (
    <div className="help pad">
      <h3>如何验证</h3>
      <ol className="help-list">
        <li>
          <strong>变量遮蔽</strong>：打开 <code>src/users.ts</code>
          ，把光标放到 <code>greet</code> 的参数 <code>name</code>{' '}
          上分析。外层参数与 <code>wrapper</code> 内{' '}
          <code>const name = 99</code> 应分为两个绑定；
          <code>shadowDemo</code> 的两个 <code>count</code> 同理。
        </li>
        <li>
          <strong>类型与值同名</strong>：在 <code>src/model.ts</code>{' '}
          分别对函数 <code>Order</code>（值空间）与接口{' '}
          <code>Order</code>（类型空间）发起分析，预览的命中集合应不同。
        </li>
        <li>
          <strong>动态访问</strong>：对 <code>User.name</code>{' '}
          属性发起分析（点 <code>user.name</code> 或{' '}
          <code>inspect</code> 中的 <code>name</code> 属性）。
          <code>obj[key]</code>、<code>Object.keys</code>、
          <code>for...in</code> 列入“未覆盖位置”，字符串与注释单独分类。
        </li>
        <li>
          <strong>分析期间再次编辑</strong>：先发起一次分析，不提交，
          回到编辑器改动任意文件；右侧立刻显示“预览已过期”，
          复核按钮锁定，直到重新分析。
        </li>
        <li>
          <strong>语法错误保留草稿</strong>：用左下角按钮新建{' '}
          <code>broken.ts</code>（内含错误），再在其它文件分析：
          阻断文件与行列被列出，不做任何替换，草稿原样保留。
        </li>
        <li>
          <strong>跨文件与撤销</strong>：对被导入符号重命名并提交后，
          “历史”页可将整次操作涉及的所有文件整体恢复。
        </li>
      </ol>
      <div className="small muted">
        颜色：绿=已证明；橙=同名其它绑定/字符串；红=动态访问未覆盖；灰=注释保留。
      </div>
    </div>
  );
}
