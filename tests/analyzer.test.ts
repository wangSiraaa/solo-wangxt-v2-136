import { describe, expect, it } from 'vitest';
import { VirtualProject } from '../src/engine/virtualProject';
import { analyzeRename } from '../src/engine/analyzer';
import type {
  OccurrenceKind,
  RenameAnalysisResult,
} from '../src/engine/types';
import { buildEdits } from '../src/engine/renameBuilder';
import { applyEdits } from '../src/engine/edit';
import { evaluateGate } from '../src/engine/gate';
import { contentVersion } from '../src/engine/version';

/* ----------------------------- 测试工程 ----------------------------- */

const SHADOW = `
export function greet(name: string): string {
  const wrapper = (): string => {
    const name = 99;
    return String(name);
  };
  void wrapper;
  return name;
}
export function two() {
  const count = 1;
  {
    const count = 2;
    return count;
  }
}
`;

const TYPE_VALUE_SAME_NAME = `interface Order { id: string; total: number }
export function Order(id: string, total: number): Order {
  return { id, total };
}
const a: Order = Order('x', 1);
`;

const DYNAMIC = `interface User { id: number; name: string }
export function run(user: User, key: string) {
  const a = user.name;
  const b = user["name"];
  const c = user[key];
  const s = "name";
  const other = { name: 123 }.name;
  const ks = Object.keys(user);
  for (const k in user) void k;
  // name in this comment stays
  const greeting = "hello name";
  void a; void b; void c; void s; void other; void ks;
}
`;

const CROSS_A = `export function shared(x: number): number { return x + 1; }`;
const CROSS_B = `import { shared } from './a';
export const v = shared(10);
`;

const SYNTAX_BAD = `export const broken = ;`;
const SYNTAX_IMPORT_BAD = `import { x } from './bad'; export const y = x;`;

function makeProject(files: Record<string, string>): VirtualProject {
  return new VirtualProject(
    Object.entries(files).map(([path, content]) => ({ path, content })),
  );
}

/**
 * 取标记位置并返回“去掉标记后”的干净源码（标记仅用于测试定位，
 * 绝不进入被分析的工程内容）。
 */
function cleanPos(marked: string, nth = 0): number {
  let markerPos = marked.indexOf('«');
  for (let i = 0; i < nth; i++) {
    markerPos = marked.indexOf('«', markerPos + 1);
  }
  if (markerPos === -1) throw new Error('缺少位置标记 «');
  const earlier = (marked.slice(0, markerPos).match(/«/g) ?? []).length;
  return markerPos - earlier;
}

function analyzeMarked(
  files: Record<string, string>,
  entry: string,
  oldName: string,
  nth = 0,
): { r: RenameAnalysisResult; clean: Record<string, string> } {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) clean[k] = v.replace(/«/g, '');
  const project = makeProject(clean);
  const position = cleanPos(files[entry], nth);
  const r = analyzeRename(project, {
    baseVersions: {},
    fileName: entry,
    position,
    oldName,
  });
  return { r, clean };
}

function kindsOf(r: RenameAnalysisResult, kind: OccurrenceKind) {
  return r.occurrences.filter((o) => o.kind === kind);
}

/* ------------------------------- 测试 ------------------------------- */

describe('变量遮蔽（同名不同作用域按绑定区分）', () => {
  it('外层参数 name 与内层 const name 被分为不同绑定', () => {
    const marked = SHADOW.replace('greet(name', 'greet(«name').replace(
      'const name = 99',
      'const «name = 99',
    );
    const { r } = analyzeMarked({ 'src/s.ts': marked }, 'src/s.ts', 'name', 0);
    expect(r.status).toBe('ok');

    const decl = r.occurrences.find(
      (o) => o.kind === 'proven' && o.isDeclaration,
    );
    expect(decl).toBeTruthy();
    expect(decl!.line).toBe(2); // 形参所在行

    // 内层 const name 必须是 otherBinding
    const inner = r.occurrences.find(
      (o) => o.kind === 'otherBinding' && o.line === 4,
    );
    expect(inner).toBeTruthy();
    expect(inner!.note).toContain('另一个符号');

    // 外层引用 line 8 的 return name 是 proven
    const outerUse = r.occurrences.find(
      (o) => o.kind === 'proven' && o.line === 8,
    );
    expect(outerUse).toBeTruthy();
  });

  it('从内层发起时，外层参数变为 otherBinding，且 proven 只在内层作用域', () => {
    const marked = SHADOW.replace('const name = 99', 'const «name = 99');
    const { r } = analyzeMarked({ 'src/s.ts': marked }, 'src/s.ts', 'name');
    const provenLines = kindsOf(r, 'proven').map((o) => o.line);
    expect(provenLines).toContain(4);
    expect(provenLines).toContain(5); // String(name) 在内层
    expect(provenLines).not.toContain(2);
    expect(provenLines).not.toContain(8);
    // 外层形参与 return name 都标记为其它绑定
    expect(
      r.occurrences.some((o) => o.line === 2 && o.kind === 'otherBinding'),
    ).toBe(true);
  });

  it('两个 count 互不联动', () => {
    const marked = SHADOW.replace('const count = 1', 'const «count = 1');
    const { r } = analyzeMarked({ 'src/s.ts': marked }, 'src/s.ts', 'count');
    // 外层 count 声明后从未使用，proven 只有声明本身（第 11 行）
    expect(kindsOf(r, 'proven').map((o) => o.line)).toEqual([11]);
    // 内层声明（13）与使用（14）都是其它绑定
    const others = kindsOf(r, 'otherBinding').map((o) => o.line).sort();
    expect(others).toEqual([13, 14]);
  });
});

describe('类型与值同名', () => {
  it('从函数 Order（值空间）发起：覆盖调用点与函数声明，不覆盖类型标注', () => {
    const marked = TYPE_VALUE_SAME_NAME.replace(
      'export function Order',
      'export function «Order',
    );
    const { r } = analyzeMarked({ 'src/m.ts': marked }, 'src/m.ts', 'Order');
    const proven = kindsOf(r, 'proven');
    expect(r.targetKindLabel).toBe('function');
    // 函数声明 + 调用处
    expect(proven.length).toBe(2);
    // 接口声明本身 + 两个类型标注里的 Order 都是接口符号 → otherBinding
    expect(kindsOf(r, 'otherBinding').length).toBe(3);
  });

  it('从接口 Order（类型空间）发起：覆盖类型标注，不覆盖调用点', () => {
    const marked = TYPE_VALUE_SAME_NAME.replace(
      'interface Order',
      'interface «Order',
    );
    const { r } = analyzeMarked({ 'src/m.ts': marked }, 'src/m.ts', 'Order');
    const proven = kindsOf(r, 'proven');
    expect(r.targetKindLabel).toBe('interface');
    expect(proven.length).toBe(3); // 接口声明(L1) + 两个类型标注（L2 返回类型、L5 变量类型）
    // 值空间的同名符号：函数声明(L2) 与调用处(L5) 都是 otherBinding
    const otherLines = kindsOf(r, 'otherBinding').map((o) => o.line).sort();
    expect(otherLines).toEqual([2, 5]);
  });
});

describe('对象属性与动态访问', () => {
  it('静态属性访问已证明；动态访问列入未覆盖；字符串/注释/其它属性各自分类', () => {
    const marked = DYNAMIC.replace('user.name', 'user.«name');
    const { r } = analyzeMarked({ 'src/d.ts': marked }, 'src/d.ts', 'name');
    expect(r.status).toBe('ok');
    expect(r.propertyLike).toBe(true);

    const provenLines = kindsOf(r, 'proven').map((o) => o.line).sort();
    expect(provenLines).toContain(1); // 接口属性声明
    expect(provenLines).toContain(3); // user.name
    expect(provenLines).toContain(4); // user["name"]

    const dynLines = kindsOf(r, 'dynamic').map((o) => o.line).sort();
    expect(dynLines).toContain(5); // user[key]
    expect(dynLines).toContain(8); // Object.keys
    expect(dynLines).toContain(9); // for...in

    // 无关对象的 name 属性是其它绑定
    expect(
      r.occurrences.some((o) => o.line === 7 && o.kind === 'otherBinding'),
    ).toBe(true);

    // 字符串文本
    const strings = kindsOf(r, 'stringText').map((o) => o.line).sort();
    expect(strings).toContain(6); // "name"
    expect(strings).toContain(11); // "hello name"

    // 注释
    expect(kindsOf(r, 'comment').some((o) => o.line === 10)).toBe(true);
  });

  it('未勾选动态确认时闸门不通过；逐条确认后通过', () => {
    const marked = DYNAMIC.replace('user.name', 'user.«name');
    const { r, clean } = analyzeMarked(
      { 'src/d.ts': marked },
      'src/d.ts',
      'name',
    );
    const versions = { 'src/d.ts': contentVersion(clean['src/d.ts']) };
    const selected = new Set(
      r.occurrences.filter((o) => o.kind === 'proven').map((o) => o.id),
    );
    const blocked = evaluateGate({
      result: r,
      currentVersions: versions,
      newName: 'fullName',
      selectedIds: selected,
      dynamicReviewed: false,
    });
    expect(blocked.ok).toBe(false);

    const ok = evaluateGate({
      result: r,
      currentVersions: versions,
      newName: 'fullName',
      selectedIds: selected,
      dynamicReviewed: true,
    });
    expect(ok.ok).toBe(true);
    expect(ok.selected.length).toBe(3);
  });

  it('字符串中的同名文本默认不生成任何编辑', () => {
    const marked = DYNAMIC.replace('user.name', 'user.«name');
    const { r, clean } = analyzeMarked(
      { 'src/d.ts': marked },
      'src/d.ts',
      'name',
    );
    const selected = r.occurrences.filter((o) => o.kind === 'proven');
    const edits = buildEdits(selected, 'fullName');
    const out = applyEdits(clean['src/d.ts'], edits.get('src/d.ts')!);
    expect(out).toContain('const s = "name";');
    expect(out).toContain('// name in this comment stays');
    expect(out).toContain('const a = user.fullName;');
    expect(out).toContain('const b = user["fullName"];');
    // 动态与无关属性不动
    expect(out).toContain('user[key]');
    expect(out).toContain('{ name: 123 }');
  });
});

describe('跨文件重命名', () => {
  it('跨模块导入的调用点被证明并可一次替换', () => {
    const markedA = CROSS_A.replace('function shared', 'function «shared');
    const { r, clean } = analyzeMarked(
      { 'src/a.ts': markedA, 'src/b.ts': CROSS_B },
      'src/a.ts',
      'shared',
    );
    const byFile = r.occurrences
      .filter((o) => o.kind === 'proven')
      .reduce<Record<string, number>>((m, o) => {
        m[o.fileName] = (m[o.fileName] ?? 0) + 1;
        return m;
      }, {});
    expect(byFile['src/a.ts']).toBe(1); // 函数声明
    expect(byFile['src/b.ts']).toBe(2); // import + 调用
    const edits = buildEdits(
      r.occurrences.filter((o) => o.kind === 'proven'),
      'renamed',
    );
    const newB = applyEdits(clean['src/b.ts'], edits.get('src/b.ts')!);
    expect(newB).toContain("import { renamed } from './a';");
    expect(newB).toContain('renamed(10)');
  });
});

describe('语法错误：保留草稿、不盲替', () => {
  it('目标文件存在语法错误时状态为 syntaxError 且无任何命中', () => {
    const project = makeProject({ 'src/bad.ts': SYNTAX_BAD });
    const pos = SYNTAX_BAD.indexOf('broken');
    const r = analyzeRename(project, {
      baseVersions: {},
      fileName: 'src/bad.ts',
      position: pos,
      oldName: 'broken',
    });
    expect(r.status).toBe('syntaxError');
    expect(r.blockingSyntax.length).toBeGreaterThan(0);
    expect(r.occurrences).toHaveLength(0);
  });

  it('导入闭包中的语法错误阻断分析；闭包外仅警告', () => {
    const project = makeProject({
      'src/importer.ts': SYNTAX_IMPORT_BAD,
      'src/bad.ts': SYNTAX_BAD,
      'src/unrelated.ts': 'export const z = 1;',
      'src/otherBad.ts': 'export const = ',
    });
    const pos = SYNTAX_IMPORT_BAD.indexOf('y');
    const r = analyzeRename(project, {
      baseVersions: {},
      fileName: 'src/importer.ts',
      position: pos,
      oldName: 'y',
    });
    expect(r.status).toBe('syntaxError');
    expect(
      r.blockingSyntax.some((s) => s.fileName === 'src/bad.ts'),
    ).toBe(true);
    expect(
      r.blockingSyntax.some((s) => s.fileName === 'src/importer.ts'),
    ).toBe(false);
    expect(
      r.otherSyntax.some((s) => s.fileName === 'src/otherBad.ts'),
    ).toBe(true);
  });
});

describe('分析期间再次编辑（共同版本复核）', () => {
  it('当前版本与分析版本不一致时闸门报告 stale 文件并拒绝提交', () => {
    const project = makeProject({ 'src/a.ts': CROSS_A });
    const pos = CROSS_A.indexOf('shared');
    const r = analyzeRename(project, {
      baseVersions: {},
      fileName: 'src/a.ts',
      position: pos,
      oldName: 'shared',
    });
    const changed = CROSS_A.replace('x + 1', 'x + 2');
    const selected = new Set(
      r.occurrences.filter((o) => o.kind === 'proven').map((o) => o.id),
    );
    const gate = evaluateGate({
      result: r,
      currentVersions: { 'src/a.ts': contentVersion(changed) },
      newName: 'renamed',
      selectedIds: selected,
      dynamicReviewed: true,
    });
    expect(gate.ok).toBe(false);
    expect(gate.staleFiles.some((f) => f.path === 'src/a.ts')).toBe(true);
  });
});

describe('简写属性的 prefix/suffix', () => {
  it('重命名局部变量时简写属性变为 name: newName 形式，对象形状不变', () => {
    const src = `export function build(name: string) {
  return { name };
}
`;
    const project = makeProject({ 'src/sh.ts': src });
    const pos = src.indexOf('name'); // 形参 name
    const r = analyzeRename(project, {
      baseVersions: {},
      fileName: 'src/sh.ts',
      position: pos,
      oldName: 'name',
    });
    const proven = r.occurrences.filter((o) => o.kind === 'proven');
    const edits = buildEdits(proven, 'fullName');
    const out = applyEdits(src, edits.get('src/sh.ts')!);
    expect(out).toContain('function build(fullName: string)');
    expect(out).toMatch(/\{\s*name:\s*fullName\s*\}/);
  });
});
