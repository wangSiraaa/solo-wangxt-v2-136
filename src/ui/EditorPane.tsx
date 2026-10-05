import { useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';
import type * as MonacoNS from 'monaco-editor';
// Monaco 的 worker 仅负责编辑器 UI（颜色、括号匹配），不参与重命名分析。
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import type { StudioApi } from '../state/studio';
import type { RenameOccurrence } from '../engine/types';

// 让所有语言共用基础 editor worker；Monaco 资源来自本地打包，不访问 CDN。
(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  },
};

let monacoConfigured = false;

function configureMonaco(monaco: typeof MonacoNS): void {
  if (monacoConfigured) return;
  monacoConfigured = true;
  // 关闭 Monaco 内置 TS 诊断：所有“证明”来自 Worker 中的 Compiler API，
  // 避免两套诊断互相矛盾。
  const tsDefaults = monaco.languages.typescript;
  tsDefaults.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  });
  tsDefaults.typescriptDefaults.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ESNext,
    jsx: monaco.languages.typescript.JsxEmit.Preserve,
    allowNonTsExtensions: true,
  });
}

const KIND_CLASS: Record<RenameOccurrence['kind'], string> = {
  proven: 'rs-mark rs-proven',
  otherBinding: 'rs-mark rs-other',
  stringText: 'rs-mark rs-string',
  dynamic: 'rs-mark rs-dynamic',
  comment: 'rs-mark rs-comment',
};

const KIND_GLYPH: Record<RenameOccurrence['kind'], string> = {
  proven: 'rs-glyph rs-glyph-proven',
  otherBinding: 'rs-glyph rs-glyph-other',
  stringText: 'rs-glyph rs-glyph-string',
  dynamic: 'rs-glyph rs-glyph-dynamic',
  comment: 'rs-glyph rs-glyph-comment',
};

interface EditorHandle {
  monaco: typeof MonacoNS;
  editor: MonacoNS.editor.IStandaloneCodeEditor;
}

export function EditorPane({
  studio,
  onHandle,
  reveal,
}: {
  studio: StudioApi;
  onHandle: (h: EditorHandle) => void;
  reveal: { path: string; offset: number } | null;
}) {
  const handleRef = useRef<EditorHandle | null>(null);
  const decorationsPerModel = useRef(
    new Map<string, MonacoNS.editor.IEditorDecorationsCollection>(),
  );

  const triggerAnalyze = () => {
    const { monaco, editor } = handleRef.current ?? {};
    if (!monaco || !editor) return;
    const pos = editor.getPosition();
    const model = editor.getModel();
    if (!pos || !model) return;
    const word = model.getWordAtPosition(pos);
    if (!word) {
      studio.flashNotice('光标下没有标识符。');
      return;
    }
    void studio.analyzeAt(
      studio.activePath,
      model.getOffsetAt(pos),
      word.word,
    );
  };

  const handleMount = (
    editor: MonacoNS.editor.IStandaloneCodeEditor,
    monaco: typeof MonacoNS,
  ) => {
    configureMonaco(monaco);
    handleRef.current = { monaco, editor };
    onHandle({ monaco, editor });
    editor.addAction({
      id: 'rs-analyze-rename',
      label: 'Rename Studio：分析光标处的重命名',
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyR,
      ],
      run: triggerAnalyze,
    });
  };

  /* 为所有文件预建模型：跨文件装饰/标记在文件尚未被打开时也能挂上去。 */
  useEffect(() => {
    const mounted = handleRef.current;
    if (!mounted || !studio.loaded) return;
    const { monaco } = mounted;
    for (const doc of Object.values(studio.docs)) {
      const uri = monaco.Uri.parse(`file:///project/${doc.path}`);
      if (!monaco.editor.getModel(uri)) {
        monaco.editor.createModel(
          doc.content,
          'typescript',
          uri,
        );
      }
    }
  }, [studio.loaded, studio.docs]);

  /* 根据会话结果绘制装饰与语法标记 */
  useEffect(() => {
    const mounted = handleRef.current;
    if (!mounted) return;
    const { monaco, editor } = mounted;

    for (const coll of decorationsPerModel.current.values()) coll.clear();

    const result = studio.session?.result;
    if (!result) {
      monaco.editor.getModels().forEach((m) =>
        monaco.editor.setModelMarkers(m, 'rename-studio', []),
      );
      return;
    }

    const byFile = new Map<string, RenameOccurrence[]>();
    for (const occ of result.occurrences) {
      const list = byFile.get(occ.fileName) ?? [];
      list.push(occ);
      byFile.set(occ.fileName, list);
    }

    const stale = new Set(
      Object.entries(result.analyzedVersions)
        .filter(([p, v]) => studio.docs[p]?.version !== v)
        .map(([p]) => p),
    );

    for (const model of monaco.editor.getModels()) {
      const path = model.uri.path.replace(/^\/project\//, '');
      const occs = byFile.get(path) ?? [];
      const decos: MonacoNS.editor.IModelDeltaDecoration[] = occs.map((o) => {
        const sp = model.getPositionAt(o.start);
        const ep = model.getPositionAt(o.start + o.length);
        const selected = studio.session?.selected.has(o.id);
        const dim = o.kind === 'proven' && !selected ? ' rs-dimmed' : '';
        const staleCls = stale.has(path) ? ' rs-stale' : '';
        return {
          range: new monaco.Range(
            sp.lineNumber,
            sp.column,
            ep.lineNumber,
            ep.column,
          ),
          options: {
            inlineClassName: `${KIND_CLASS[o.kind]}${dim}${staleCls}`,
            glyphMarginClassName: KIND_GLYPH[o.kind],
            overviewRuler: {
              color:
                o.kind === 'dynamic'
                  ? '#e5484d'
                  : o.kind === 'proven'
                    ? '#30a46c'
                    : '#f5a623',
              position: monaco.editor.OverviewRulerLane.Right,
            },
            hoverMessage: { value: hoverFor(o) },
          },
        };
      });

      let coll = decorationsPerModel.current.get(path);
      if (!coll) {
        coll = editor.createDecorationsCollection(decos);
        decorationsPerModel.current.set(path, coll);
      } else {
        coll.set(decos);
      }

      const issues = [
        ...result.blockingSyntax
          .filter((s) => s.fileName === path)
          .map((s) => ({ s, sev: monaco.MarkerSeverity.Error })),
        ...result.otherSyntax
          .filter((s) => s.fileName === path)
          .map((s) => ({ s, sev: monaco.MarkerSeverity.Warning })),
      ];
      monaco.editor.setModelMarkers(
        model,
        'rename-studio',
        issues.map(({ s, sev }) => {
          const a = model.getPositionAt(s.start);
          const b = model.getPositionAt(s.start + s.length);
          return {
            startLineNumber: a.lineNumber,
            startColumn: a.column,
            endLineNumber: b.lineNumber,
            endColumn: b.column,
            message: s.message,
            severity: sev,
          };
        }),
      );
    }
  }, [studio.session, studio.docs]);

  /* 右侧面板点击命中 → 跳转并居中 */
  useEffect(() => {
    const mounted = handleRef.current;
    if (!mounted || !reveal) return;
    const { monaco, editor } = mounted;
    const uri = monaco.Uri.parse(`file:///project/${reveal.path}`);
    const model = monaco.editor.getModel(uri);
    if (model) {
      const pos = model.getPositionAt(reveal.offset);
      editor.setModel(model);
      editor.setPosition(pos);
      editor.revealLineInCenter(pos.lineNumber);
      editor.focus();
    }
  }, [reveal]);

  return (
    <div className="editor-pane">
      <div className="editor-toolbar">
        <button className="btn primary" onClick={triggerAnalyze}>
          分析光标处的重命名
        </button>
        <span className="hint">
          Ctrl/Cmd + Shift + R · 仅静态分析，不执行工程代码，无后端
        </span>
      </div>
      <div className="editor-host">
        {studio.loaded && studio.activePath && (
          <Editor
            height="100%"
            theme="vs-dark"
            path={studio.activePath}
            language="typescript"
            value={studio.docs[studio.activePath]?.content}
            onChange={(value) => studio.updateDoc(studio.activePath, value ?? '')}
            onMount={handleMount}
            options={{
              fontSize: 13,
              glyphMargin: true,
              minimap: { enabled: false },
              automaticLayout: true,
              scrollBeyondLastLine: false,
              fixedOverflowWidgets: true,
            }}
          />
        )}
      </div>
    </div>
  );
}

function hoverFor(o: RenameOccurrence): string {
  const title: Record<RenameOccurrence['kind'], string> = {
    proven: '✅ 已证明（符号绑定一致）',
    otherBinding: '⚠️ 同名但绑定到另一个符号',
    stringText: '❓ 字符串文本：需人工逐处判断',
    dynamic: '⛔ 动态访问：编译器无法证明，未覆盖',
    comment: '💬 注释文本：默认保留',
  };
  return [title[o.kind], o.symbolLabel, o.note].filter(Boolean).join('\n\n');
}
