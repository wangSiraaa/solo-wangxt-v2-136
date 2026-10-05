import type {
  RenameAnalysisResult,
  RenameOccurrence,
} from './types';

/**
 * 提交前闸门：把“已证明”与“仍需人工判断”分开，
 * 只有满足全部硬性条件且用户对风险项逐处确认后才允许生成编辑。
 */

export interface FileFreshness {
  path: string;
  baseVersion?: string;
  currentVersion?: string;
  fresh: boolean;
}

export interface GateIssue {
  code:
    | 'stale'
    | 'syntax'
    | 'cannotRename'
    | 'notIdentifier'
    | 'noSelection'
    | 'newNameInvalid'
    | 'newNameClash';
  message: string;
}

export interface GateInput {
  result: RenameAnalysisResult;
  /** 编辑器中的当前文件版本（用户可能在分析后又改了代码） */
  currentVersions: Record<string, string>;
  newName: string;
  /** 用户勾选要替换的 proven 命中 id */
  selectedIds: ReadonlySet<string>;
  /** 用户是否已逐处确认未覆盖的动态访问位置 */
  dynamicReviewed: boolean;
}

const IDENT_RE = /^[\p{ID_Start}$_][\p{ID_Continue}$]*$/u;

export function isValidIdentifier(name: string): boolean {
  return IDENT_RE.test(name);
}

export function evaluateGate(input: GateInput): {
  ok: boolean;
  issues: GateIssue[];
  staleFiles: FileFreshness[];
  selected: RenameOccurrence[];
} {
  const { result, currentVersions, newName, selectedIds, dynamicReviewed } =
    input;
  const issues: GateIssue[] = [];
  const staleFiles: FileFreshness[] = [];

  /* 1. 分析本身可用性 */
  if (result.status === 'syntaxError') {
    issues.push({
      code: 'syntax',
      message:
        '存在阻止分析的语法错误，已保留编辑器草稿；请先修复后重新分析，不会做任何替换。',
    });
  }
  if (result.status === 'cannotRename') {
    issues.push({
      code: 'cannotRename',
      message: result.cannotRenameReason ?? '该位置无法重命名。',
    });
  }
  if (result.status === 'notIdentifier') {
    issues.push({
      code: 'notIdentifier',
      message: '光标位置不是标识符。',
    });
  }

  /* 2. 新名字法 */
  if (!isValidIdentifier(newName)) {
    issues.push({
      code: 'newNameInvalid',
      message: `新名称 “${newName}” 不是合法标识符。`,
    });
  }
  if (
    newName === result.oldName &&
    result.status === 'ok'
  ) {
    issues.push({ code: 'newNameClash', message: '新名称与旧名称相同。' });
  }

  /* 3. 共同版本复核：分析基线 vs 当前编辑器版本 */
  for (const [path, baseVersion] of Object.entries(result.analyzedVersions)) {
    const currentVersion = currentVersions[path];
    const fresh = currentVersion === baseVersion;
    if (!fresh) {
      staleFiles.push({ path, baseVersion, currentVersion, fresh: false });
    }
  }
  if (staleFiles.length > 0) {
    issues.push({
      code: 'stale',
      message: `分析之后 ${staleFiles.length} 个文件又被修改，预览已过期，请重新分析后再提交。`,
    });
  }

  /* 4. 勾选项（只可能是 proven 命中） */
  const selected = result.occurrences.filter(
    (o) => o.kind === 'proven' && selectedIds.has(o.id),
  );
  if (result.status === 'ok' && selected.length === 0) {
    issues.push({
      code: 'noSelection',
      message: '没有勾选任何已证明的替换位置。',
    });
  }

  /* 5. 未覆盖位置必须逐处确认（动态访问无法自动判定） */
  if (!dynamicReviewed && hasDynamic(result)) {
    issues.push({
      code: 'noSelection',
      message:
        '仍存在未逐处确认的动态访问位置（obj[name]、for...in 等），请先在“未覆盖位置”中逐条确认。',
    });
  }

  return {
    ok: issues.length === 0,
    issues,
    staleFiles,
    selected,
  };
}

function hasDynamic(result: RenameAnalysisResult): boolean {
  return result.occurrences.some((o) => o.kind === 'dynamic');
}
