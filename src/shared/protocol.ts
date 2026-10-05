// Worker <-> 主线程 通信协议与共享类型。
// 引擎本身不触碰 DOM / IndexedDB，可在 Node 自测中复用。

export type LocationKind =
  | 'local-variable' // 局部变量 / 参数（按符号绑定识别）
  | 'type' // 类型别名 / 接口 / 类型参数
  | 'function' // 函数声明 / 函数表达式名
  | 'value' // 类值、枚举值、const 等其它值绑定
  | 'property'; // 对象属性（同一属性符号，含字符串字面量键）

export type ItemStatus =
  | 'proven' // 编译器可证明属于该符号
  | 'property' // 属性符号（跨文件同名属性仍可能冲突，建议复核）
  | 'string' // 字符串字面量中的同名引用，无法证明绑定
  | 'excluded'; // 同名但属于别的绑定 / 别的作用域，默认不改

export interface RenameItem {
  file: string;
  start: number;
  end: number; // 不含引号；字符串键同样只覆盖引号内部
  startLine: number;
  startCol: number;
  endLine: number;
  kind: LocationKind;
  status: ItemStatus;
  /** 形如 `Shadowing.ts 中 for 循环内 let 声明` 的人类可读作用域说明 */
  scope: string;
  snippet: string;
  /** excluded 行的原因 */
  excludedReason?: string;
  /** 动态/字符串等无法证明的位置，为什么无法分析 */
  uncertainty?: string;
  defaultSelected: boolean;
  /** 简写属性 `{ name }` 改名时编译器给出的前/后缀（如 `: oldName`），用于保留注释与格式 */
  prefixText?: string;
  suffixText?: string;
}

export interface SyntaxErrorInfo {
  file: string;
  start: number;
  startLine: number;
  startCol: number;
  message: string;
}

export interface AnalyzeResult {
  ok: boolean;
  triggerFile: string;
  triggerPos: number;
  oldName: string;
  displayName: string;
  /** 重命名是否被编译器允许（语法错误、关键字位置等为 false） */
  canRename: boolean;
  /** canRename=false 的人类可读原因；触发文件草稿保持不变 */
  blockReason?: string;
  items: RenameItem[];
  syntaxErrors: SyntaxErrorInfo[];
  /** 分析时每个文件的版本与内容哈希，用于提交前共同版本复核 */
  baselines: Record<string, { rev: number; hash: string }>;
}

export interface AnalyzeRequest {
  type: 'analyze';
  id: number;
  files: { path: string; content: string; rev: number }[];
  file: string;
  pos: number;
}

export interface SelfCheckRequest {
  type: 'selfcheck';
  id: number;
}

export type WorkerRequest = AnalyzeRequest | SelfCheckRequest;

export interface SelfCheckResult {
  ok: boolean;
  checks: { name: string; pass: boolean; detail: string }[];
}

export type WorkerResponse =
  | ({ type: 'analyze'; id: number } & AnalyzeResult)
  | ({ type: 'selfcheck'; id: number } & SelfCheckResult)
  | { type: 'error'; id: number; message: string };

// ---- 纯文本编辑（供引擎、自测与主线程共用） ----

export interface TextEdit {
  start: number;
  end: number;
  newText: string;
}

/**
 * 按下标从后向前应用编辑，保留所有未涉及区间（含注释与无关格式）。
 * 编辑区间互相重叠时返回 null，调用方应阻止提交。
 */
export function applyEdits(content: string, edits: TextEdit[]): string | null {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let next = content;
  let prevStart = Infinity;
  for (const e of sorted) {
    if (e.end > next.length || e.start < 0 || e.end < e.start) return null;
    if (e.end > prevStart) return null; // 与后一个编辑重叠
    next = next.slice(0, e.start) + e.newText + next.slice(e.end);
    prevStart = e.start;
  }
  return next;
}

export function cyrb53(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(13, '0');
}
