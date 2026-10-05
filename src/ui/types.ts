import type { AnalyzeResult, RenameItem } from '../shared/protocol';

export interface FileState {
  path: string;
  content: string;
  /** 从磁盘/IDB 起单调递增的版本号，任何编辑都会 +1 */
  rev: number;
}

export interface PreviewState {
  result: AnalyzeResult;
  /** 分析发起时的文件快照（rev/hash），提交前据此复核共同版本 */
  snapshot: Record<string, { content: string; rev: number }>;
  newName: string;
  /** key=file:start:end，记录用户逐项勾选（含被强制纳入的字符串候选） */
  selected: Record<string, boolean>;
  loading: boolean;
  /** 分析期间文件再次被编辑 -> 结果过期，必须重新分析才能提交 */
  stale: boolean;
  staleFiles: string[];
  error?: string;
}

export const itemKey = (i: RenameItem): string => `${i.file}:${i.start}:${i.end}`;
