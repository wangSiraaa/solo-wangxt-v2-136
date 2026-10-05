import { describe, expect, it } from 'vitest';
import { VirtualProject } from '../src/engine/virtualProject';
import { analyzeRename } from '../src/engine/analyzer';
import { buildEdits } from '../src/engine/renameBuilder';
import { applyEdits, diffLines } from '../src/engine/edit';
import { evaluateGate } from '../src/engine/gate';
import { contentVersion } from '../src/engine/version';

describe('端到端：分析 → 闸门 → 编辑 → 差异', () => {
  it('遮蔽场景下只改外层绑定，注释、缩进、字符串与内层绑定原样保留', () => {
    const src = `// keep this name comment
export function greet(name: string) {
  const inner = (): string => {
    const name = 99;   // shadow name, keep formatting
    return "x" + name;
  };
  return \`hi \${name}\`;
}
`;
    const project = new VirtualProject([{ path: 'g.ts', content: src }]);
    const pos = src.indexOf('name: string');
    const r = analyzeRename(project, {
      baseVersions: {},
      fileName: 'g.ts',
      position: pos,
      oldName: 'name',
    });
    expect(r.status).toBe('ok');

    const versions = { 'g.ts': contentVersion(src) };
    const selected = new Set(
      r.occurrences.filter((o) => o.kind === 'proven').map((o) => o.id),
    );
    const gate = evaluateGate({
      result: r,
      currentVersions: versions,
      newName: 'displayName',
      selectedIds: selected,
      dynamicReviewed: true,
    });
    expect(gate.ok).toBe(true);

    const edits = buildEdits(gate.selected, 'displayName');
    const list = edits.get('g.ts')!;
    const out = applyEdits(src, list);

    // 形参与模板插值改名
    expect(out).toContain('function greet(displayName: string)');
    expect(out).toContain('`hi ${displayName}`');
    // 内层遮蔽绑定未动
    expect(out).toMatch(/const name = 99;\s+\/\/ shadow name/);
    expect(out).toContain('"x" + name');
    // 注释原样
    expect(out.startsWith('// keep this name comment')).toBe(true);
    // 缩进/空行等无关格式：diff 只触及含改动的行
    const changed = diffLines(src, out).filter((l) => l.kind !== 'equal');
    const changedOld = changed.filter((l) => l.kind === 'delete').map((l) => l.oldNo);
    expect(changedOld).toEqual([2, 7]);
  });

  it('模板静态文本中的同名片段不被替换（只替换 ${ } 表达式里的绑定）', () => {
    const src = 'export function f(name: string) { return `name=${name}`; }\n';
    const project = new VirtualProject([{ path: 't.ts', content: src }]);
    const r = analyzeRename(project, {
      baseVersions: {},
      fileName: 't.ts',
      position: src.indexOf('name'),
      oldName: 'name',
    });
    const edits = buildEdits(
      r.occurrences.filter((o) => o.kind === 'proven'),
      'displayName',
    );
    const out = applyEdits(src, edits.get('t.ts')!);
    expect(out).toBe(
      'export function f(displayName: string) { return `name=${displayName}`; }\n',
    );
  });
});
