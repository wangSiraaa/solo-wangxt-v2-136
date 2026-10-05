import { useEffect, useRef } from 'react';
import * as MonacoNS from 'monaco-editor';
import type * as Monaco from 'monaco-editor';
import { setupMonaco } from '../editor/setup';
import type { FileState, PreviewState } from './types';
import { itemKey } from './types';

interface EditorPaneProps {
  file: FileState | null;
  preview: PreviewState | null;
  onEdit: (path: string, content: string) => void;
  onCursorSymbol: (file: string, pos: number, word: string | null) => void;
  /** 在（可能尚未激活的）文件中按偏移量定位光标并居中 */
  registerReveal: (fn: (file: string, offset: number) => void) => void;
}

function kindLabel(kind: string): string {
  switch (kind) {
    case 'local-variable':
      return '局部变量/参数';
    case 'property':
      return '对象属性';
    case 'type':
      return '类型符号';
    case 'function':
      return '函数';
    default:
      return '值绑定';
  }
}

export function EditorPane({ file, preview, onEdit, onCursorSymbol, registerReveal }: EditorPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof MonacoNS | null>(null);
  const modelsRef = useRef<Map<string, Monaco.editor.ITextModel>>(new Map());
  const decorationsRef = useRef<string[]>([]);
  const fileRef = useRef<FileState | null>(null);
  fileRef.current = file;
  // 跨文件点击时，父组件先切换激活文件再请求定位；此处缓存请求，待模型切换后执行
  const pendingRevealRef = useRef<{ path: string; offset: number } | null>(null);

  // 初始化编辑器（仅一次）
  useEffect(() => {
    const monaco = setupMonaco();
    monacoRef.current = monaco;
    const editor = monaco.editor.create(hostRef.current!, {
      theme: 'rp-dark',
      automaticLayout: true,
      fontSize: 13,
      glyphMargin: true,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'all',
    });
    editorRef.current = editor;

    editor.onDidChangeModelContent(() => {
      const f = fileRef.current;
      if (!f) return;
      const model = modelsRef.current.get(f.path);
      if (model && model.getValue() !== f.content) {
        onEdit(f.path, model.getValue());
      }
    });

    let lastWord: string | null = null;
    let lastPos = -1;
    editor.onDidChangeCursorPosition((e) => {
      const f = fileRef.current;
      if (!f) return;
      const model = editor.getModel();
      if (!model) return;
      const pos = model.getOffsetAt(e.position);
      const word = model.getWordAtPosition(e.position)?.word ?? null;
      if (pos !== lastPos || word !== lastWord) {
        lastPos = pos;
        lastWord = word;
        onCursorSymbol(f.path, pos, word);
      }
    });

    registerReveal((path, offset) => {
      pendingRevealRef.current = { path, offset };
      // 若当前模型正是目标文件，立即执行
      const m = modelsRef.current.get(path);
      if (m && editor.getModel()?.uri.toString() === m.uri.toString()) {
        const pos = m.getPositionAt(offset);
        editor.setPosition(pos);
        editor.revealPositionInCenter(pos);
        editor.focus();
        pendingRevealRef.current = null;
      }
    });

    return () => editor.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 文件切换 / 模型管理 / 外部内容同步（提交、撤销、载入场景）
  useEffect(() => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!monaco || !editor || !file) return;
    let model = modelsRef.current.get(file.path);
    if (!model) {
      const uri = monaco.Uri.parse('inmemory:///' + file.path);
      model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(file.content, 'typescript', uri);
      modelsRef.current.set(file.path, model);
    }
    if (editor.getModel()?.uri.toString() !== model.uri.toString()) {
      editor.setModel(model);
    }
    if (model.getValue() !== file.content) {
      model.setValue(file.content);
    }
    // 模型就绪后处理待定位请求
    const pending = pendingRevealRef.current;
    if (pending && pending.path === file.path) {
      const pos = model.getPositionAt(pending.offset);
      editor.setPosition(pos);
      editor.revealPositionInCenter(pos);
      pendingRevealRef.current = null;
    }
  }, [file]);

  // 预览装饰：✓ 已证明 / ○ 需人工判断 / ✕ 同名不同绑定
  useEffect(() => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!monaco || !editor || !file) return;
    const model = modelsRef.current.get(file.path);
    if (!model) return;

    if (!preview || !preview.result.ok || preview.stale) {
      decorationsRef.current = model.deltaDecorations(decorationsRef.current, []);
      return;
    }

    const decos: Monaco.editor.IModelDeltaDecoration[] = [];
    for (const item of preview.result.items.filter((i) => i.file === file.path)) {
      const selected = preview.selected[itemKey(item)] ?? item.defaultSelected;
      const startPos = model.getPositionAt(item.start);
      const endPos = model.getPositionAt(item.end);
      let className = 'rp-proven-on';
      let glyphClass = 'rp-glyph rp-glyph-proven-on';
      let color = '#3fb950';
      let hover = '';
      if (item.status === 'excluded') {
        className = 'rp-excluded';
        glyphClass = 'rp-glyph rp-glyph-excluded';
        color = '#7a8599';
        hover = `**已排除 · 同名不同绑定**\n\n${item.excludedReason ?? ''}\n\n作用域：${item.scope}`;
      } else if (item.status === 'string') {
        className = selected ? 'rp-string-on' : 'rp-string';
        glyphClass = selected ? 'rp-glyph rp-glyph-string-on' : 'rp-glyph rp-glyph-string';
        color = '#e8b14a';
        hover = `**需人工判断**\n\n${item.uncertainty ?? ''}\n\n作用域：${item.scope}`;
      } else {
        className = selected ? 'rp-proven-on' : 'rp-proven-off';
        glyphClass = selected ? 'rp-glyph rp-glyph-proven-on' : 'rp-glyph rp-glyph-proven-off';
        hover = `**已由编译器证明** · ${kindLabel(item.kind)}\n\n作用域：${item.scope}\n\n改名后：${preview.newName}`;
      }
      decos.push({
        range: new monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column),
        options: {
          className,
          isWholeLine: false,
          glyphMarginClassName: glyphClass,
          glyphMarginHoverMessage: { value: hover },
          hoverMessage: { value: hover },
          overviewRuler: { color, position: monaco.editor.OverviewRulerLane.Right },
        },
      });
    }
    decorationsRef.current = model.deltaDecorations(decorationsRef.current, decos);
  }, [preview, file]);

  return <div ref={hostRef} className="editor-host" />;
}
