import type { RenameOccurrence } from './types';
import type { TextEdit } from './edit';

/**
 * 从“已被用户逐项勾选、且由编译器证明”的命中生成编辑。
 * otherBinding / stringText / comment / dynamic 永远不会进入这里。
 *
 * TypeScript findRenameLocations 的 prefixText/suffixText 语义
 * （tsc 源码 getPrefixAndSuffixText：name = originalNode.text，即【旧名】）：
 *
 *   textSpan 覆盖原标识符文本，最终文本 = prefixText + 新名 + suffixText。
 *
 * 用例：
 *   重命名局部变量 name -> fullName，简写属性 { name }：
 *     prefixText = "name: "（保留旧属性名）→ "name: fullName"
 *   重命名对象属性 name -> fullName，简写属性 { name }：
 *     suffixText = ": name"（保留旧局部名）→ "fullName: name"
 *   import { a } 中本地 a 改名 b：
 *     prefixText = "a as " → "a as b"
 *   obj[0] 数字键重命名时 prefix/suffix 为引号。
 */
export function buildEdits(
  selected: RenameOccurrence[],
  newName: string,
): Map<string, TextEdit[]> {
  const byFile = new Map<string, TextEdit[]>();
  for (const occ of selected) {
    if (occ.kind !== 'proven') continue;
    const list = byFile.get(occ.fileName) ?? [];
    list.push({
      start: occ.start,
      length: occ.length,
      newText: `${occ.prefixText ?? ''}${newName}${occ.suffixText ?? ''}`,
    });
    byFile.set(occ.fileName, list);
  }
  return byFile;
}
