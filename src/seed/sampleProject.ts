/**
 * 内置验证工程：刻意覆盖
 * 1) 变量遮蔽（同名不同作用域）
 * 2) 类型与值同名（interface Order 与 function Order）
 * 3) 对象属性的静态 / 动态访问、for...in、Object.keys
 * 4) 字符串与注释中的同名文本（默认保留）
 * 5) 跨文件导入重命名
 */

export interface SeedFile {
  path: string;
  content: string;
}

export const SEED_FILES: SeedFile[] = [
  {
    path: 'src/types.ts',
    content: `// 领域类型定义（本注释里出现的 name 不应被自动改动）
export interface User {
  id: number;
  name: string;
}

export type UserName = string;
`,
  },
  {
    path: 'src/model.ts',
    content: `// 类型与值同名：interface Order 与 function Order 分属类型空间与值空间。
export interface Order {
  id: string;
  total: number;
}

// 值空间的 Order：调用点重命名不应波及类型标注里的 Order。
export function Order(id: string, total: number): Order {
  return { id, total };
}

const pending: Order = Order('A-1', 10);

// 形参 total 与属性 Order.total 同名但绑定完全不同。
export function describe(total: string): string {
  return "total in string"; // 字符串里的 total 需人工判断
}
`,
  },
  {
    path: 'src/users.ts',
    content: `import type { User } from './types';

// greet 的参数 name 与 User.name 属性同名，但绑定不同。
export function greet(name: string): string {
  // TODO: 以后可以把 name 改成完整称呼（注释，不参与替换）
  const wrapper = (): string => {
    const name = 99; // 遮蔽外层参数：这是另一个绑定
    return \`local \${name}\`;
  };
  const label = \`name=\${name}\`; // 模板静态文本里的 name 不自动改
  void wrapper;
  return "name: " + name;
}

export function shadowDemo(): number {
  const count = 1;
  {
    const count = 2; // 遮蔽外层 count，重命名时不得联动
    return count;
  }
}

export function inspect(user: User, key: string) {
  const staticProp = user.name;        // 已证明：User.name
  const staticStr = user["name"];      // 已证明：字面量键与属性关联
  const dynamicVar = user[key];        // 未覆盖：obj[key]
  const bareString = "name";           // 字符串文本：无法证明
  const other = { name: 123 }.name;    // 其它绑定：无关对象属性
  const keys = Object.keys(user);      // 未覆盖：反射枚举
  for (const k in user) void k;        // 未覆盖：for...in
  return { staticProp, staticStr, dynamicVar, bareString, other, keys };
}
`,
  },
  {
    path: 'src/main.ts',
    content: `import { greet, shadowDemo } from './users';
import { Order } from './model';
import type { User } from './types';

const user: User = { id: 1, name: 'Ada' };

export function main(): void {
  console.log(greet(user.name));
  console.log(shadowDemo());
  const order = Order('X-9', 42);
  console.log(order);
}
`,
  },
];
