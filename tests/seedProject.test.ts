import { describe, expect, it } from 'vitest';
import { VirtualProject } from '../src/engine/virtualProject';
import { analyzeRename } from '../src/engine/analyzer';
import { SEED_FILES } from '../src/seed/sampleProject';

/*
 * UI“验证指引”页对内置工程行为的承诺，由本测试保证不漂移：
 * 遮蔽、类型/值同名、动态访问、字符串/注释分类都必须如指引所述。
 */
function seedProject() {
  return new VirtualProject(
    SEED_FILES.map((f) => ({ path: f.path, content: f.content })),
  );
}

function analyzeAtWord(
  files: { path: string; content: string }[],
  file: string,
  lineFragment: string,
  word: string,
  occurrence = 0,
) {
  const content = files.find((f) => f.path === file)!.content;
  const lines = content.split('\n');
  const lineNo = lines.findIndex((l) => l.includes(lineFragment));
  if (lineNo === -1) throw new Error(`找不到行：${lineFragment}`);
  const lineOffset = lines
    .slice(0, lineNo)
    .reduce((n, l) => n + l.length + 1, 0);
  let col = -1;
  for (let i = 0; i <= occurrence; i++) col = lines[lineNo].indexOf(word, col + 1);
  if (col === -1) throw new Error(`行内找不到 ${word}#${occurrence}`);
  return analyzeRename(
    new VirtualProject(files.map((f) => ({ path: f.path, content: f.content }))),
    {
      baseVersions: {},
      fileName: file,
      position: lineOffset + col,
      oldName: word,
    },
  );
}

describe('内置验证工程', () => {
  it('greet 的参数 name：wrapper 内 name 为其它绑定；模板/双引号字符串与注释不动', () => {
    const r = analyzeAtWord(
      SEED_FILES,
      'src/users.ts',
      'export function greet(name',
      'name',
    );
    expect(r.status).toBe('ok');
    const lines = r.occurrences
      .filter((o) => o.kind === 'otherBinding')
      .map((o) => o.line)
      .sort();
    // const name = 99（遮蔽）
    expect(lines.length).toBeGreaterThan(0);
    expect(
      r.occurrences.some(
        (o) =>
          o.kind === 'otherBinding' &&
          o.snippetText.includes('const name = 99'),
      ),
    ).toBe(true);
    // 模板静态文本与普通字符串是 stringText
    expect(
      r.occurrences.some(
        (o) =>
          o.kind === 'stringText' &&
          o.snippetText.includes('name=${name}') === false &&
          (o.snippetText.includes('name=') ||
            o.snippetText.includes('"name: "')),
      ),
    ).toBe(true);
    // 注释
    expect(
      r.occurrences.some(
        (o) => o.kind === 'comment' && o.snippetText.includes('TODO'),
      ),
    ).toBe(true);
  });

  it('User.name 属性：静态点访问/字面量键已证明，key 动态，Object.keys/for...in 未覆盖', () => {
    const r = analyzeAtWord(
      SEED_FILES,
      'src/users.ts',
      'const staticProp = user.name',
      'name',
    );
    expect(r.status).toBe('ok');
    expect(r.propertyLike).toBe(true);
    const proven = r.occurrences.filter((o) => o.kind === 'proven');
    // 接口属性声明 + user.name + user["name"]
    expect(proven.length).toBeGreaterThanOrEqual(3);
    const dynNotes = r.occurrences
      .filter((o) => o.kind === 'dynamic')
      .map((o) => o.snippetText);
    expect(dynNotes.some((t) => t.includes('user[key]'))).toBe(true);
    expect(dynNotes.some((t) => t.includes('Object.keys'))).toBe(true);
    expect(dynNotes.some((t) => t.includes('for (const k in user)'))).toBe(
      true,
    );
    // 无关对象字面量属性
    expect(
      r.occurrences.some(
        (o) =>
          o.kind === 'otherBinding' &&
          o.snippetText.includes('{ name: 123 }'),
      ),
    ).toBe(true);
  });

  it('model.ts：函数 Order 与接口 Order 是两套不同的命中集合', () => {
    const asFunction = analyzeAtWord(
      SEED_FILES,
      'src/model.ts',
      'export function Order',
      'Order',
    );
    const asInterface = analyzeAtWord(
      SEED_FILES,
      'src/model.ts',
      'export interface Order',
      'Order',
    );
    expect(asFunction.targetKindLabel).toBe('function');
    expect(asInterface.targetKindLabel).toBe('interface');

    // 函数名位置与接口名位置的 proven 命中集合互不重合（按 文件+偏移 判定）
    const fnProvenKeys = new Set(
      asFunction.occurrences
        .filter((o) => o.kind === 'proven')
        .map((o) => `${o.fileName}:${o.start}`),
    );
    const ifProvenKeys = new Set(
      asInterface.occurrences
        .filter((o) => o.kind === 'proven')
        .map((o) => `${o.fileName}:${o.start}`),
    );
    const fnDecl = asFunction.occurrences.find(
      (o) =>
        o.kind === 'proven' &&
        o.snippetText.includes('function Order') &&
        o.isDeclaration,
    );
    const ifDecl = asInterface.occurrences.find(
      (o) =>
        o.kind === 'proven' &&
        o.snippetText.includes('interface Order') &&
        o.isDeclaration,
    );
    expect(fnDecl).toBeTruthy();
    expect(ifDecl).toBeTruthy();
    // 函数名偏移不在“接口重命名”的 proven 集合里，反之亦然
    expect(ifProvenKeys.has(`${fnDecl!.fileName}:${fnDecl!.start}`)).toBe(
      false,
    );
    expect(fnProvenKeys.has(`${ifDecl!.fileName}:${ifDecl!.start}`)).toBe(
      false,
    );
  });

  it('跨文件：main.ts 中 Order(...) 与 greet(user.name) 的绑定均可从入口文件解析', () => {
    const project = seedProject();
    const main = SEED_FILES.find((f) => f.path === 'src/main.ts')!.content;
    const pos = main.indexOf('greet(user.name)') + 'greet(user.'.length;
    const r = analyzeRename(project, {
      baseVersions: {},
      fileName: 'src/main.ts',
      position: pos,
      oldName: 'name',
    });
    // User.name 是属性
    expect(r.status).toBe('ok');
    expect(r.propertyLike).toBe(true);
    expect(
      r.occurrences.some(
        (o) => o.kind === 'proven' && o.fileName === 'src/types.ts',
      ),
    ).toBe(true);
  });

  it('种子工程全部文件无语法错误', () => {
    const project = seedProject();
    const r = analyzeRename(project, {
      baseVersions: {},
      fileName: 'src/main.ts',
      position: SEED_FILES.find((f) => f.path === 'src/main.ts')!.content.indexOf(
        'main',
      ),
      oldName: 'main',
    });
    expect(r.blockingSyntax).toHaveLength(0);
  });
});
