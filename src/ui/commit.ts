import { applyEdits, cyrb53, type AnalyzeResult, type RenameItem, type TextEdit } from '../shared/protocol';
import type { FileState, PreviewState } from './types';
import { itemKey } from './types';

/** 单个条目的编辑：prefix/suffix 折进替换文本（简写属性展开），保证区间不重叠。 */
export function editForItem(item: RenameItem, newName: string): TextEdit {
  return {
    start: item.start,
    end: item.end,
    newText: (item.prefixText ?? '') + newName + (item.suffixText ?? ''),
  };
}

/** 计算提交结果；任一组区间重叠返回 null（不应发生，但绝不盲目替换）。 */
export function buildCommit(
  files: FileState[],
  result: AnalyzeResult,
  selected: Record<string, boolean>,
  newName: string,
): { path: string; content: string; rev: number; count: number }[] | null {
  const chosen = new Map<string, RenameItem[]>();
  for (const item of result.items) {
    if (item.status === 'excluded') continue;
    if (!(selected[itemKey(item)] ?? item.defaultSelected)) continue;
    const arr = chosen.get(item.file) ?? [];
    arr.push(item);
    chosen.set(item.file, arr);
  }
  const out: { path: string; content: string; rev: number; count: number }[] = [];
  for (const [path, items] of chosen) {
    const f = files.find((x) => x.path === path);
    if (!f) return null;
    const next = applyEdits(
      f.content,
      items.map((i) => editForItem(i, newName)),
    );
    if (next === null) return null;
    out.push({ path, content: next, rev: f.rev + 1, count: items.length });
  }
  return out;
}

/** 提交前共同版本复核：rev 与内容哈希都必须与分析时一致。 */
export function verifyBaselines(
  files: FileState[],
  baselines: AnalyzeResult['baselines'],
): { ok: boolean; drifted: string[] } {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const drifted: string[] = [];
  for (const [path, b] of Object.entries(baselines)) {
    const f = byPath.get(path);
    if (!f) {
      drifted.push(path);
      continue;
    }
    if (f.rev !== b.rev || cyrb53(f.content) !== b.hash) drifted.push(path);
  }
  return { ok: drifted.length === 0, drifted };
}

export function snapshotOf(files: FileState[]): PreviewState['snapshot'] {
  const snap: PreviewState['snapshot'] = {};
  for (const f of files) snap[f.path] = { content: f.content, rev: f.rev };
  return snap;
}

/** 分析后若文件再次编辑：对照快照判定过期。 */
export function detectDrift(files: FileState[], snapshot: PreviewState['snapshot']): string[] {
  const drifted: string[] = [];
  for (const f of files) {
    const s = snapshot[f.path];
    if (!s) continue; // 分析后新增文件不影响已有偏移，但语义可能变化；忽略其漂移
    if (f.rev !== s.rev || f.content !== s.content) drifted.push(f.path);
  }
  return drifted;
}
