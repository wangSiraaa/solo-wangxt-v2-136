/**
 * 编辑应用与差异计算（纯函数，主线程直接使用，Worker 不参与）。
 *
 * 原则：
 * - 不做任何全文盲替；每个替换都来自分析产出的、用户逐项确认过的偏移区间。
 * - 同文件自后向前替换，偏移保持有效。
 * - 未命中的区间（注释、字符串、其它绑定）原样保留——注释与无关格式因此自然保留。
 */

export interface TextEdit {
  start: number;
  length: number;
  newText: string;
}

export interface FileEdit {
  path: string;
  /** 应用所基于的原始内容（共同版本的内容） */
  oldContent: string;
  edits: TextEdit[];
}

export interface AppliedFile {
  path: string;
  oldContent: string;
  newContent: string;
}

export interface OverlapInfo {
  a: TextEdit;
  b: TextEdit;
}

/** 同一文件内编辑区间不得相交（同一点的声明/引用不会重复产出）。 */
export function findOverlap(edits: TextEdit[]): OverlapInfo | null {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.start < prev.start + prev.length) {
      return { a: prev, b: cur };
    }
  }
  return null;
}

export function applyEdits(content: string, edits: TextEdit[]): string {
  const overlap = findOverlap(edits);
  if (overlap) {
    throw new Error(
      `编辑区间相交：[${overlap.a.start}, +${overlap.a.length}) 与 [${overlap.b.start}, +${overlap.b.length})`,
    );
  }
  // 自后向前，偏移不受前面替换影响。
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = content;
  for (const edit of sorted) {
    out =
      out.slice(0, edit.start) +
      edit.newText +
      out.slice(edit.start + edit.length);
  }
  return out;
}

export function applyAll(fileEdits: FileEdit[]): AppliedFile[] {
  return fileEdits.map((fe) => ({
    path: fe.path,
    oldContent: fe.oldContent,
    newContent: applyEdits(fe.oldContent, fe.edits),
  }));
}

/* ----------------------- 极简行级 diff ----------------------- */

export type DiffLineKind = 'equal' | 'insert' | 'delete';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 新旧行号（1-based，不存在为 0） */
  oldNo: number;
  newNo: number;
}

/** 基于 LCS 的行级差异，供复核弹窗逐行展示“已证明的改动”。 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length;
  const m = b.length;

  // dp[i][j] = a[i:] 与 b[j:] 的 LCS 长度
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'equal', text: a[i], oldNo: oldNo++, newNo: newNo++ });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'delete', text: a[i], oldNo: oldNo++, newNo: 0 });
      i++;
    } else {
      out.push({ kind: 'insert', text: b[j], oldNo: 0, newNo: newNo++ });
      j++;
    }
  }
  while (i < n) {
    out.push({ kind: 'delete', text: a[i++], oldNo: oldNo++, newNo: 0 });
  }
  while (j < m) {
    out.push({ kind: 'insert', text: b[j++], oldNo: 0, newNo: newNo++ });
  }
  return out;
}
