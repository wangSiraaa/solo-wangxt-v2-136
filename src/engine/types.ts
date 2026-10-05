/**
 * Worker <-> 主线程通信协议与共享类型。
 * 主线程从不直接导入 typescript 包，引擎返回的数据只包含可结构化克隆的值。
 */

export type FileKind = 'ts' | 'tsx';

export interface FileState {
  path: string;
  content: string;
  /** 内容版本（哈希），见 version.ts */
  version: string;
}

export interface ProjectSnapshot {
  files: FileState[];
}

/**
 * 单个“命中位置”的分类：
 * - proven       已由 TypeScript 符号绑定证明属于目标符号 → 默认勾选
 * - otherBinding 同名但符号绑定不同（变量遮蔽 / 类型与值同名等）→ 永不自动勾选
 * - stringText   普通字符串内容里的同名文本 → 需人工逐处判断
 * - dynamic      动态属性访问（obj[name] / for...in / Object.entries），
 *                编译器无法证明是否指向该属性 → 需人工处理，不可勾选
 * - comment      注释中的同名文本 → 默认不动，尽量保留原注释
 */
export type OccurrenceKind =
  | 'proven'
  | 'otherBinding'
  | 'stringText'
  | 'dynamic'
  | 'comment';

export interface RenameOccurrence {
  id: string;
  fileName: string;
  /** UTF-16 偏移 */
  start: number;
  length: number;
  kind: OccurrenceKind;
  /** 是否为声明处 */
  isDeclaration: boolean;
  /** 1-based 行号 */
  line: number;
  /** 命中所在行原文及列信息 */
  snippetText: string;
  startCharacter: number;
  /** 该命中绑定的符号描述（proven/otherBinding 用） */
  symbolLabel?: string;
  /** dynamic / stringText 的人工判断提示 */
  note?: string;
  /**
   * 编译器提供的前后缀文本（如对象简写属性 { name } 重命名属性时
   * 需变为 { newName: name }），只在 proven 命中上可能出现。
   */
  prefixText?: string;
  suffixText?: string;
}

export interface SyntaxIssue {
  fileName: string;
  start: number;
  length: number;
  line: number;
  startCharacter: number;
  message: string;
}

export interface RenameAnalysisInput {
  /** 发起分析时的全部文件版本（共同版本基线） */
  baseVersions: Record<string, string>;
  fileName: string;
  position: number;
  oldName: string;
}

export type AnalysisStatus =
  | 'ok'
  | 'cannotRename'
  | 'syntaxError'
  | 'notIdentifier';

export interface RenameAnalysisResult {
  status: AnalysisStatus;
  oldName: string;
  triggerFileName: string;
  triggerPosition: number;
  /** 编译器给出的目标符号显示名（如 函数 user、接口 User） */
  targetLabel?: string;
  targetKindLabel?: string;
  /** 是否为对象/接口属性类符号（决定是否需要扫描动态访问） */
  propertyLike: boolean;
  occurrences: RenameOccurrence[];
  /** 阻止重命名的语法错误（目标文件或其导入闭包） */
  blockingSyntax: SyntaxIssue[];
  /** 不阻止但提示的其它文件语法错误 */
  otherSyntax: SyntaxIssue[];
  cannotRenameReason?: string;
  /** 本次分析实际读取的文件版本快照 */
  analyzedVersions: Record<string, string>;
  baseVersions: Record<string, string>;
}

/* ---------------- Worker 协议 ---------------- */

export type WorkerRequest =
  | {
      type: 'init';
      snapshot: ProjectSnapshot;
    }
  | {
      type: 'updateFile';
      path: string;
      content: string;
      version: string;
    }
  | {
      type: 'analyze';
      requestId: number;
      input: RenameAnalysisInput;
    };

export type WorkerResponse =
  | { type: 'ready' }
  | {
      type: 'analyzeResult';
      requestId: number;
      result: RenameAnalysisResult;
    }
  | { type: 'error'; requestId?: number; message: string };
