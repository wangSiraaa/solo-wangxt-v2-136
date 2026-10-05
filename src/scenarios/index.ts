// 内置验证工程：覆盖变量遮蔽、类型/值同名、属性动态访问、跨文件改名。

export interface ScenarioFile {
  path: string;
  content: string;
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  files: ScenarioFile[];
  /** 建议光标所在的 file 与标识符（引擎接收 offset，由 UI 查找） */
  cursor: { file: string; identifier: string; occurrence?: number };
}

export const scenarios: Scenario[] = [
  {
    id: 'shadowing',
    name: '变量遮蔽',
    description: '外层 count 与 for 循环、函数参数中的同名 count 是三个绑定；对象属性 count 又是另一个符号。',
    files: [
      {
        path: 'Shadowing.ts',
        content: `// 顶层注释保持不动
function demo() {
  const count = 1; // 外层 count（试着把光标放在这里发起重命名）
  const doubled = count * 2;

  for (const count of [1, 2]) {
    // 内层 count 遮蔽外层：应出现在“同名不同绑定·已排除”
    console.log(count);
  }

  function inner(count: number) {
    // 参数 count 是第三个绑定：同样必须排除
    return count + doubled;
  }

  return count + inner(count);
}

const meta = { count: 9 }; // 属性 count：第四个符号
`,
      },
    ],
    cursor: { file: 'Shadowing.ts', identifier: 'count', occurrence: 2 },
  },
  {
    id: 'type-value',
    name: '类型与值同名',
    description: '类 Box 同时是类型与值。在类型标注处改名不应动 new Box()，反之亦然。',
    files: [
      {
        path: 'Box.ts',
        content: `class Box {
  constructor(public v: number) {}
}

// 光标放在类型标注的 Box 上：只改类型引用
const b: Box = new Box(1);

function take(x: Box): Box {
  return new Box(x.v + 1);
}
`,
      },
    ],
    cursor: { file: 'Box.ts', identifier: 'Box', occurrence: 2 },
  },
  {
    id: 'props',
    name: '属性·字符串·动态访问',
    description: '可证明的属性引用、字符串键候选与无法分析的动态计算访问必须分组呈现。',
    files: [
      {
        path: 'Props.ts',
        content: `interface User {
  name: string;
}

const u: User = { name: 'ada' };
const direct = u.name;
const byKey = u['name'];           // 字符串键：无法证明，默认不勾选
const dynamicKey = 'na' + 'me';
const dyn = u[dynamicKey];         // 动态访问：列入未覆盖位置，绝不自动改
const eventName = 'name';          // 普通字符串：列出但默认不改
`,
      },
    ],
    cursor: { file: 'Props.ts', identifier: 'name', occurrence: 1 },
  },
  {
    id: 'cross-file',
    name: '跨文件改名',
    description: '导出的接口在两个文件中联动；提交前复核共同版本，撤销恢复整次操作。',
    files: [
      {
        path: 'src/types.ts',
        content: `export interface User {
  id: number;
  name: string; // 重命名时这条注释必须保留
}

export function greet(u: User): string {
  return 'hi ' + u.name;
}
`,
      },
      {
        path: 'src/app.ts',
        content: `import { greet, type User } from './types';

const u: User = { id: 1, name: 'bob' };

export function run(): void {
  console.log(greet(u));
  console.log(u.name);
}
`,
      },
    ],
    cursor: { file: 'src/types.ts', identifier: 'User', occurrence: 1 },
  },
  {
    id: 'syntax-error',
    name: '语法错误保留草稿',
    description: '触发文件有语法错误时不生成任何替换，只展示错误，草稿原样保留。',
    files: [
      {
        path: 'Broken.ts',
        content: `const value = 1;
const broken = (;
console.log(value);
`,
      },
    ],
    cursor: { file: 'Broken.ts', identifier: 'value', occurrence: 1 },
  },
];

export function findIdentifierOffset(content: string, identifier: string, occurrence = 1): number {
  let at = -1;
  for (let i = 0; i < occurrence; i++) {
    at = content.indexOf(identifier, at + 1);
    if (at < 0) return Math.max(0, content.indexOf(identifier));
  }
  return at;
}
