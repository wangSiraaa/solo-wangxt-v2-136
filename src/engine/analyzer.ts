import ts from 'typescript';
import { VirtualProject, normalizePath } from './virtualProject';
import { buildSnippet, lineAndCharAt } from './text';
import { contentVersion } from './version';
import type {
  OccurrenceKind,
  RenameAnalysisInput,
  RenameAnalysisResult,
  RenameOccurrence,
  SyntaxIssue,
} from './types';

/**
 * 重命名分析核心。
 *
 * 输出的每个命中都带有“置信类别”，UI 与提交闸门据此区别对待：
 *   proven       —— findRenameLocations + 符号双重确认，默认勾选
 *   otherBinding —— 同名但符号绑定不同（遮蔽 / 类型与值同名 / 另一个属性），不勾选
 *   stringText   —— 字符串/JSX 文本中的同名文本，人工逐处判断
 *   dynamic      —— 动态访问，编译器无法证明，列为“未覆盖位置”
 *   comment      —— 注释中的同名文本，默认保留不动
 *
 * 本模块只做静态分析：不执行任何导入代码，不访问磁盘或网络。
 */

interface ProvenSpan {
  start: number;
  length: number;
  prefixText?: string;
  suffixText?: string;
}

export function analyzeRename(
  project: VirtualProject,
  input: RenameAnalysisInput,
): RenameAnalysisResult {
  const absFile = project.normalize(input.fileName);
  const content = project.getContent(absFile) ?? '';
  const oldName = input.oldName;
  const program = project.service.getProgram()!;
  const triggerSf = program.getSourceFile(absFile);

  const base: RenameAnalysisResult = {
    status: 'ok',
    oldName,
    triggerFileName: project.relative(absFile),
    triggerPosition: input.position,
    propertyLike: false,
    occurrences: [],
    blockingSyntax: [],
    otherSyntax: [],
    analyzedVersions: {},
    baseVersions: input.baseVersions,
  };

  if (!triggerSf) {
    return {
      ...base,
      status: 'notIdentifier',
      cannotRenameReason: '文件不存在于工程中。',
    };
  }

  /* ---------- 1. 语法诊断：闭包内错误阻断，闭包外仅提示 ---------- */
  const closure = importClosure(project, absFile);
  const blocking: SyntaxIssue[] = [];
  const other: SyntaxIssue[] = [];
  for (const fileName of project.getFileNames()) {
    const sf = program.getSourceFile(fileName);
    if (!sf) continue;
    const diags = project.service.getSyntacticDiagnostics(fileName);
    const bucket = closure.has(fileName) ? blocking : other;
    for (const d of diags) {
      bucket.push(toSyntaxIssue(project, sf.text, fileName, d));
    }
  }
  base.blockingSyntax = blocking;
  base.otherSyntax = other;
  if (blocking.length > 0) {
    // 不返回任何替换建议：草稿原样保留在编辑器中，由用户修复后重新分析。
    return { ...base, status: 'syntaxError' };
  }

  /* ---------- 2. 光标处是否为可重命名标识符 ---------- */
  const token = identifierAtPosition(triggerSf, input.position);
  if (
    !token ||
    token.text !== oldName ||
    !(ts.isIdentifier(token) || ts.isPrivateIdentifier(token))
  ) {
    return { ...base, status: 'notIdentifier' };
  }

  const renameInfo = project.service.getRenameInfo(absFile, input.position, {
    allowRenameOfImportPath: false,
  });
  if (!renameInfo.canRename) {
    return {
      ...base,
      status: 'cannotRename',
      cannotRenameReason:
        renameInfo.localizedErrorMessage ?? '该位置无法重命名。',
    };
  }

  const targetLabel = renameInfo.fullDisplayName;
  const checker = program.getTypeChecker();

  /*
   * 目标符号与 kind 取自“光标节点所在的声明”，而不是 getRenameInfo /
   * getSymbolAtLocation 的合并结果：interface X 与 function X 同名时，
   * getSymbolAtLocation(接口名) 返回的合并符号同时携带两个声明。
   */
  const triggerDecl = declarationOfNameNode(token);
  const targetKindLabel = triggerDecl
    ? nodeKindLabel(triggerDecl)
    : renameInfo.kind;
  const propertyLike = triggerDecl
    ? isPropertyLikeDeclaration(triggerDecl)
    : renameInfo.kind === 'property';

  /* ---------- 3. 编译器给出的重命名位置（已证明） ---------- */
  const rawRenameLocations =
    project.service.findRenameLocations(
      absFile,
      input.position,
      /* findInStrings */ false,
      /* findInComments */ false,
      /* providePrefixAndSuffixTextForRename */ true,
    ) ?? [];

  /*
   * 关键过滤：当同名符号同时占据类型空间与值空间
   * （interface X + function X、type X + const X）时，
   * findRenameLocations 会把两个空间的引用合并返回。
   * 按“触发声明所在空间”保留同空间位置；被过滤掉的另一空间同名位置，
   * 稍后在 AST 扫描中归类为 otherBinding，明确提示是另一个绑定。
   */
  const targetSpace = declarationSpace(triggerDecl);
  const renameLocations =
    targetSpace === 'ambient'
      ? [...rawRenameLocations]
      : rawRenameLocations.filter((loc) => {
          const sf2 = program.getSourceFile(loc.fileName);
          if (!sf2) return false;
          const node = identifierAtPosition(sf2, loc.textSpan.start + 1);
          const space = node
            ? locationSpace(node, checker)
            : 'ambient';
          return space === 'ambient' || space === targetSpace;
        });

  const provenByFile = new Map<string, ProvenSpan[]>();
  for (const loc of renameLocations) {
    const list = provenByFile.get(loc.fileName) ?? ([] as ProvenSpan[]);
    list.push({
      start: loc.textSpan.start,
      length: loc.textSpan.length,
      prefixText: loc.prefixText,
      suffixText: loc.suffixText,
    });
    provenByFile.set(loc.fileName, list);
  }

  /*
   * “已证明绑定”判定：
   *  - targetDeclKey：触发位置对应的声明键（跨文件导入也能解析到源声明）；
   *  - 对于接口名这类合并符号，取与触发声明同类的那一个声明；
   *  - 空间（type/value）必须一致，杜绝 interface X / function X 互相认领。
   */
  const targetDeclKey = pickTargetDeclKey(checker, token, triggerDecl);
  const targetSpaceForScan = targetSpace;

  /* ---------- 4. 逐文件扫描 ---------- */
  const occurrences: RenameOccurrence[] = [];
  for (const fileName of project.getFileNames()) {
    const sf = program.getSourceFile(fileName);
    if (!sf) continue;
    scanFile({
      sf,
      relPath: project.relative(fileName),
      proven: provenByFile.get(fileName) ?? [],
      oldName,
      propertyLike,
      checker,
      targetDeclKey,
      targetSpace: targetSpaceForScan,
      out: occurrences,
    });
  }

  occurrences.sort((a, b) =>
    a.fileName === b.fileName
      ? a.start - b.start
      : a.fileName < b.fileName
        ? -1
        : 1,
  );
  assignIds(occurrences);

  /* ---------- 5. 记录分析实际读取的内容版本 ---------- */
  const analyzedVersions: Record<string, string> = {};
  for (const fileName of project.getFileNames()) {
    const contentNow = project.getContent(fileName)!;
    analyzedVersions[project.relative(fileName)] =
      contentVersion(contentNow);
  }

  return {
    ...base,
    status: 'ok',
    targetLabel,
    targetKindLabel,
    propertyLike,
    occurrences,
    analyzedVersions,
  };
}

/* ================================================================== */

interface ScanArgs {
  sf: ts.SourceFile;
  relPath: string;
  proven: ProvenSpan[];
  oldName: string;
  propertyLike: boolean;
  checker: ts.TypeChecker;
  targetDeclKey: string | undefined;
  targetSpace: 'type' | 'value' | 'ambient' | 'ambivalent';
  out: RenameOccurrence[];
}

function scanFile(args: ScanArgs): void {
  const {
    sf,
    relPath,
    proven,
    oldName,
    propertyLike,
    checker,
    targetDeclKey,
    targetSpace,
    out,
  } = args;
  const text = sf.text;

  const inProven = (start: number, end: number): ProvenSpan | undefined =>
    proven.find((p) => intervalsOverlap(p.start, p.start + p.length, start, end));

  const mkOcc = (
    start: number,
    length: number,
    kind: OccurrenceKind,
    extra: Partial<RenameOccurrence> = {},
  ): RenameOccurrence => {
    const pos = lineAndCharAt(text, start);
    const snip = buildSnippet(text, start, length);
    return {
      id: '',
      fileName: relPath,
      start,
      length,
      kind,
      isDeclaration: false,
      line: pos.line,
      snippetText: snip.text,
      startCharacter: snip.startCharacter,
      ...extra,
    };
  };

  /* 4.1 编译器已证明的命中（可能是标识符，也可能是字符串字面量键，
        含简写属性所需的 prefix/suffix） */
  for (const p of proven) {
    const node = nodeAtSpan(sf, p.start, p.length);
    out.push(
      mkOcc(p.start, p.length, 'proven', {
        prefixText: p.prefixText,
        suffixText: p.suffixText,
        isDeclaration: node ? isNameOfAnyDeclaration(node) : false,
        symbolLabel: describeTokenSymbol(checker, identifierOf(node)),
      }),
    );
  }

  /* 4.2 AST 遍历：同名标识符（其它绑定 / 动态访问）、字符串、JSX 文本、注释 */
  const dynamicSites = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      const start = node.getStart(sf);
      const end = node.getEnd();
      const isProven = !!inProven(start, end);

      // obj[expr]：只要接收者的类型上存在目标属性，键表达式就是未覆盖位置，
      // 与键本身叫什么名字无关（key / propName / "name" 同理）。
      const dynElem =
        propertyLike && !isProven
          ? elementAccessDynamic(node, checker, oldName)
          : undefined;
      if (dynElem) {
        if (!dynamicSites.has(start)) {
          dynamicSites.add(start);
          out.push(
            mkOcc(start, end - start, 'dynamic', {
              note: dynElem,
              symbolLabel: describeTokenSymbol(checker, node) ?? '键表达式',
            }),
          );
        }
      } else if (!isProven && node.text === oldName) {
        const sym = checker.getSymbolAtLocation(node);
        const nodeDecl = declarationOfNameNode(node);
        const nodeKey = declarationKey(checker, node);
        const space = locationSpace(node, checker);
        const spaceOk =
          targetSpace === 'ambient' ||
          targetSpace === 'ambivalent' ||
          space === 'ambient' ||
          space === targetSpace;
        const sameBinding =
          spaceOk &&
          sym !== undefined &&
          targetDeclKey !== undefined &&
          nodeKey === targetDeclKey;
        out.push(
          mkOcc(start, end - start, sameBinding ? 'proven' : 'otherBinding', {
            isDeclaration: isNameOfAnyDeclaration(node),
            symbolLabel: describeSymbol(sym, checker),
            ...(sameBinding
              ? { note: '符号绑定一致（findRenameLocations 未列出，已用声明比对补充）' }
              : {
                  note: !spaceOk
                    ? '同名但处于另一绑定空间（类型 vs 值）'
                    : sym
                      ? '同名但绑定到另一个符号（遮蔽 / 类型与值同名 / 无关属性）'
                      : '编译器未能解析此处绑定，需人工判断',
                }),
          }),
        );
        void nodeDecl;
      }
    } else if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      !inProven(node.getStart(sf), node.getEnd())
    ) {
      // 字符串字面量中的同名文本（引号/反引号之内）。
      const raw = node.getText(sf);
      for (const m of matchNameInside(raw, oldName)) {
        const absStart = node.getStart(sf) + m.offset;
        const note = stringNote(node, propertyLike);
        const kind: OccurrenceKind = note?.startsWith('动态')
          ? 'dynamic'
          : 'stringText';
        out.push(
          mkOcc(absStart, oldName.length, kind, { note: note ?? '字符串文本，需人工判断是否与目标符号相关' }),
        );
      }
    } else if (ts.isJsxText?.(node)) {
      const raw = node.getText(sf);
      for (const m of matchNameWords(raw, oldName)) {
        out.push(
          mkOcc(node.getStart(sf) + m.offset, oldName.length, 'stringText', {
            note: 'JSX 文本内容，需人工判断',
          }),
        );
      }
    } else if (propertyLike) {
      // 不带标识符文本的动态位置：Object.keys/entries、for...in
      const bare = bareDynamicSite(node, oldName);
      if (bare !== undefined) {
        const start = node.getStart(sf);
        if (!dynamicSites.has(start)) {
          dynamicSites.add(start);
          out.push(
            mkOcc(bare.start, bare.length, 'dynamic', { note: bare.note }),
          );
        }
      }
    }

    /* 注释：挂在每个节点的前导/尾随 trivia，按起点去重。 */
    collectCommentRanges(sf, node).forEach((range) => {
      if (!commentSeen.has(range[0])) {
        commentSeen.add(range[0]);
        const slice = text.slice(range[0], range[1]);
        for (const m of matchNameWords(slice, oldName)) {
          out.push(
            mkOcc(range[0] + m.offset, oldName.length, 'comment', {
              note: '注释文本，默认保留，不参与替换',
            }),
          );
        }
      }
    });

    ts.forEachChild(node, visit);
  };
  const commentSeen = new Set<number>();
  visit(sf);
}

/* ------------------------- 动态访问识别 ------------------------- */

/**
 * 若 node 是 obj[expr] 的键表达式，且 obj 的类型上有名为 oldName 的属性，
 * 则该处无法静态证明键值指向目标属性 → 未覆盖位置。
 * 字面量键（user["name"]）若能被编译器关联会出现在 proven 中，已提前排除。
 */
function elementAccessDynamic(
  node: ts.Node,
  checker: ts.TypeChecker,
  oldName: string,
): string | undefined {
  const parent = node.parent;
  if (
    ts.isElementAccessExpression(parent) &&
    parent.argumentExpression === node
  ) {
    const receiverType = checker.getTypeAtLocation(parent.expression);
    if (receiverType.getProperty(oldName)) {
      return '动态属性访问 obj[expr]：键值在运行时才确定，无法证明指向目标属性';
    }
  }
  // name in obj —— 左侧同名标识符可能是在探测目标属性
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.InKeyword &&
    parent.left === node &&
    node.getText() === oldName
  ) {
    const receiverType = checker.getTypeAtLocation(parent.right);
    if (receiverType.getProperty(oldName)) {
      return 'in 操作符 expr in obj：无法证明探测的是目标属性';
    }
  }
  return undefined;
}

function bareDynamicSite(
  node: ts.Node,
  oldName: string,
): { start: number; length: number; note: string } | undefined {
  // for (const k in obj)
  if (ts.isForInStatement(node)) {
    const expr = node.expression;
    return {
      start: expr.getStart(node.getSourceFile()),
      length: expr.getText(node.getSourceFile()).length,
      note: 'for...in 枚举对象键：重命名属性后枚举结果改变，需人工确认',
    };
  }
  // Object.keys / entries / values / getOwnPropertyNames(...)
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression)
  ) {
    const pae = node.expression;
    const obj = pae.expression.getText();
    const method = pae.name.text;
    if (
      (obj === 'Object' &&
        (method === 'keys' ||
          method === 'entries' ||
          method === 'values' ||
          method === 'getOwnPropertyNames')) ||
      method === 'getOwnPropertyDescriptors'
    ) {
      return {
        start: pae.name.getStart(node.getSourceFile()),
        length: method.length,
        note: `${obj}.${method}() 反射式访问，无法静态证明属性名集合`,
      };
    }
  }
  void oldName;
  return undefined;
}

/* ------------------------- 字符串 ------------------------- */

function stringNote(node: ts.Node, propertyLike: boolean): string | undefined {
  if (!propertyLike) return undefined;
  const parent = node.parent;
  if (
    ts.isElementAccessExpression(parent) &&
    parent.argumentExpression === node
  ) {
    return '动态属性访问 obj["x"]：字面量键未被编译器关联到目标属性，需人工确认';
  }
  if (isPropertyNameNode(node)) {
    return '对象字面量/类型中的字符串属性名，编译器未将其关联到目标符号';
  }
  return undefined;
}

function isPropertyNameNode(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  return (
    ((ts.isPropertyAssignment(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isGetAccessor(p) ||
      ts.isSetAccessor(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodSignature(p) ||
      ts.isEnumMember(p)) &&
      (p as { name?: ts.Node }).name === node)
  );
}

/* ------------------------- 注释 ------------------------- */

function collectCommentRanges(
  sf: ts.SourceFile,
  node: ts.Node,
): Array<[number, number]> {
  const text = sf.text;
  const out: Array<[number, number]> = [];
  if (node === sf) {
    ts.getLeadingCommentRanges(text, 0)?.forEach((r) =>
      out.push([r.pos, r.end]),
    );
  }
  ts.getLeadingCommentRanges(text, node.getFullStart())?.forEach((r) =>
    out.push([r.pos, r.end]),
  );
  ts.getTrailingCommentRanges(text, node.getEnd())?.forEach((r) =>
    out.push([r.pos, r.end]),
  );
  if (node.end === sf.end) {
    ts.getLeadingCommentRanges(text, sf.end)?.forEach((r) =>
      out.push([r.pos, r.end]),
    );
  }
  return out;
}

/* ------------------------- 符号工具 ------------------------- */

/** 若标识符是某个声明的名字节点，返回该声明；否则返回 undefined。 */
function declarationOfNameNode(
  node: ts.Identifier | ts.PrivateIdentifier,
): ts.Declaration | undefined {
  const p = node.parent;
  if (!p) return undefined;
  // 只接受声明性节点；排除属性访问 obj.name（也有 name 属性但不是声明）。
  const isDeclLike =
    ts.isBindingElement(p) ||
    ts.isVariableDeclaration(p) ||
    ts.isParameter(p) ||
    ts.isFunctionDeclaration(p) ||
    ts.isClassDeclaration(p) ||
    ts.isInterfaceDeclaration(p) ||
    ts.isTypeAliasDeclaration(p) ||
    ts.isEnumDeclaration(p) ||
    ts.isEnumMember(p) ||
    ts.isPropertyDeclaration(p) ||
    ts.isPropertySignature(p) ||
    ts.isPropertyAssignment(p) ||
    ts.isMethodDeclaration(p) ||
    ts.isMethodSignature(p) ||
    ts.isGetAccessor(p) ||
    ts.isSetAccessor(p) ||
    ts.isImportSpecifier(p) ||
    ts.isExportSpecifier(p) ||
    ts.isTypeParameterDeclaration(p);
  if (isDeclLike) {
    const named = p as { name?: ts.Node };
    if (named.name === node || ts.isBindingElement(p)) return p as ts.Declaration;
  }
  return undefined;
}

function nodeKindLabel(decl: ts.Declaration): string {
  if (ts.isInterfaceDeclaration(decl)) return 'interface';
  if (ts.isClassDeclaration(decl)) return 'class';
  if (ts.isTypeAliasDeclaration(decl)) return 'type';
  if (ts.isEnumDeclaration(decl)) return 'enum';
  if (ts.isFunctionDeclaration(decl)) return 'function';
  if (
    ts.isPropertyDeclaration(decl) ||
    ts.isPropertySignature(decl) ||
    ts.isPropertyAssignment(decl) ||
    ts.isMethodDeclaration(decl) ||
    ts.isMethodSignature(decl) ||
    ts.isEnumMember(decl)
  ) {
    return 'property';
  }
  if (ts.isParameter(decl)) return 'parameter';
  return 'identifier';
}

function isPropertyLikeDeclaration(d: ts.Declaration): boolean {
  return (
    ts.isPropertyDeclaration(d) ||
    ts.isPropertySignature(d) ||
    ts.isPropertyAssignment(d) ||
    ts.isMethodDeclaration(d) ||
    ts.isMethodSignature(d) ||
    ts.isGetAccessor(d) ||
    ts.isSetAccessor(d) ||
    ts.isEnumMember(d)
  );
}

/**
 * 声明所在的绑定空间：
 * - type：接口、类型别名、类型参数（纯类型空间）
 * - value：变量、参数、函数、类、属性、枚举值等（值空间；类同时是类型，
 *   但改名时其类型引用与值引用都应联动，归为 value/ambivalent）
 * - ambivalent：类、枚举（类型与值合并，改名联动）
 */
function declarationSpace(
  decl: ts.Declaration | undefined,
): 'type' | 'value' | 'ambient' | 'ambivalent' {
  if (!decl) return 'ambient';
  if (
    ts.isInterfaceDeclaration(decl) ||
    ts.isTypeAliasDeclaration(decl) ||
    ts.isTypeParameterDeclaration(decl)
  ) {
    return 'type';
  }
  if (ts.isClassDeclaration(decl) || ts.isEnumDeclaration(decl)) {
    return 'ambivalent';
  }
  if (
    ts.isFunctionDeclaration(decl) ||
    ts.isVariableDeclaration(decl) ||
    ts.isParameter(decl) ||
    ts.isBindingElement(decl) ||
    ts.isPropertyDeclaration(decl) ||
    ts.isPropertyAssignment(decl) ||
    ts.isMethodDeclaration(decl) ||
    ts.isEnumMember(decl) ||
    ts.isPropertySignature(decl) ||
    ts.isMethodSignature(decl) ||
    ts.isGetAccessor(decl) ||
    ts.isSetAccessor(decl)
  ) {
    return 'value';
  }
  return 'ambient';
}

/**
 * 某个标识符位置最终指向的“声明键”（文件:位置）。
 * 对合并符号（interface + function 同名），解析其全部声明，
 * 由调用方按触发声明种类挑选。
 */
function declarationKeysOf(
  checker: ts.TypeChecker,
  node: ts.Identifier | ts.PrivateIdentifier,
): { key: string; decl: ts.Declaration }[] {
  let sym = checker.getSymbolAtLocation(node);
  if (sym && sym.flags & ts.SymbolFlags.Alias) {
    sym = checker.getAliasedSymbol(sym);
  }
  if (!sym) return [];
  return (sym.declarations ?? []).map((d) => ({ key: declKeyOf(d), decl: d }));
}

function declarationKey(
  checker: ts.TypeChecker,
  node: ts.Identifier | ts.PrivateIdentifier,
): string | undefined {
  return declarationKeysOf(checker, node)[0]?.key;
}

/**
 * 触发位置的目标声明键：
 * 若光标本身在某个声明名上，优先就是该声明；
 * 否则取它解析到的、与触发空间同类的声明。
 */
function pickTargetDeclKey(
  checker: ts.TypeChecker,
  token: ts.Identifier | ts.PrivateIdentifier,
  triggerDecl: ts.Declaration | undefined,
): string | undefined {
  if (triggerDecl) return declKeyOf(triggerDecl);
  const all = declarationKeysOf(checker, token);
  return all[0]?.key;
}

function declKeyOf(d: ts.Declaration): string {
  return `${d.getSourceFile().fileName}:${d.pos}`;
}

/**
 * 任意标识符位置所处的绑定空间。
 * 声明节点按声明种类；引用节点按语法上下文：
 * 向上找到第一个“会决定该标识符被当作类型还是值”的父节点。
 */
function locationSpace(
  node: ts.Identifier | ts.PrivateIdentifier,
  checker: ts.TypeChecker,
): 'type' | 'value' | 'ambient' {
  void checker;
  const decl = declarationOfNameNode(node);
  const ds = declarationSpace(decl);
  if (ds === 'type' || ds === 'value' || ds === 'ambivalent') {
    // 类/枚举声明名本身：类型与值联动，两边都接受
    return ds === 'ambivalent' ? 'ambient' : ds;
  }

  // 引用位置：沿父链找类型上下文
  let cur: ts.Node = node;
  while (cur.parent) {
    const p = cur.parent;
    if (ts.isTypeReferenceNode(p) && p.typeName === cur) return 'type';
    if (ts.isExpressionWithTypeArguments(p) && p.expression === cur) {
      return 'type';
    }
    if (
      ts.isTypeQueryNode(p) ||
      ts.isTypeOperatorNode(p) ||
      ts.isIndexedAccessTypeNode(p)
    ) {
      return 'type';
    }
    // import { X } / import type { X } 的说明符
    if (ts.isImportSpecifier(p) && (p.propertyName ?? p.name) === cur) {
      const specTypeOnly = Boolean(
        (p as { isTypeOnly?: boolean }).isTypeOnly,
      );
      const clause = p.parent?.parent;
      const clauseTypeOnly =
        !!clause &&
        ts.isImportClause(clause) &&
        Boolean((clause as { isTypeOnly?: boolean }).isTypeOnly);
      return specTypeOnly || clauseTypeOnly ? 'type' : 'value';
    }
    cur = p;
  }
  return 'value';
}

function describeTokenSymbol(
  checker: ts.TypeChecker,
  node: ts.Identifier | ts.PrivateIdentifier | undefined,
): string | undefined {
  if (!node) return undefined;
  return describeSymbol(checker.getSymbolAtLocation(node), checker);
}

function describeSymbol(
  sym: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): string | undefined {
  if (!sym) return undefined;
  const s =
    sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
  const decl = s.declarations?.[0];
  const kind = decl ? declarationKind(decl) : flagKind(sym);
  const where = decl
    ? `${decl.getSourceFile().fileName.replace(/^\/project\//, '')}:${
        sfLine(decl)
      }`
    : '';
  return `${kind} ${s.name}${where ? `（${where}）` : ''}`;
}

function sfLine(node: ts.Node): number {
  return sfLineOf(node.getSourceFile(), node.getStart());
}

function sfLineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function declarationKind(decl: ts.Declaration): string {
  const k = decl.kind;
  const map: Partial<Record<ts.SyntaxKind, string>> = {
    [ts.SyntaxKind.Parameter]: '参数',
    [ts.SyntaxKind.BindingElement]: '解构变量',
    [ts.SyntaxKind.VariableDeclaration]: '局部变量',
    [ts.SyntaxKind.PropertyDeclaration]: '类属性',
    [ts.SyntaxKind.PropertySignature]: '接口属性',
    [ts.SyntaxKind.PropertyAssignment]: '对象属性',
    [ts.SyntaxKind.MethodDeclaration]: '方法',
    [ts.SyntaxKind.MethodSignature]: '方法签名',
    [ts.SyntaxKind.FunctionDeclaration]: '函数',
    [ts.SyntaxKind.ClassDeclaration]: '类',
    [ts.SyntaxKind.InterfaceDeclaration]: '接口',
    [ts.SyntaxKind.TypeAliasDeclaration]: '类型别名',
    [ts.SyntaxKind.EnumDeclaration]: '枚举',
    [ts.SyntaxKind.EnumMember]: '枚举成员',
    [ts.SyntaxKind.ImportSpecifier]: '导入绑定',
    [ts.SyntaxKind.ImportClause]: '默认导入',
  };
  return map[k] ?? ts.SyntaxKind[k] ?? '符号';
}

function flagKind(sym: ts.Symbol): string {
  if (sym.flags & ts.SymbolFlags.TypeAlias) return '类型别名';
  if (sym.flags & ts.SymbolFlags.Interface) return '接口';
  if (sym.flags & ts.SymbolFlags.Class) return '类';
  if (sym.flags & ts.SymbolFlags.Property) return '属性';
  return '符号';
}

function isNameOfAnyDeclaration(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  return (
    (p as { name?: ts.Node }).name === node ||
    ts.isBindingElement(p) ||
    ts.isImportSpecifier(p) ||
    ts.isExportSpecifier(p) ||
    ts.isParameter(p) ||
    ts.isVariableDeclaration(p) ||
    ts.isFunctionDeclaration(p) ||
    ts.isClassDeclaration(p) ||
    ts.isPrivateIdentifier(node)
  );
}

function nodeAtSpan(sf: ts.SourceFile, start: number, length: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (n.getStart(sf) === start && n.getEnd() === start + length) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

function identifierOf(
  node: ts.Node | undefined,
): ts.Identifier | ts.PrivateIdentifier | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node;
  return undefined;
}

/**
 * 找出光标触及的标识符节点（含边界）。
 * 只接受 Identifier/PrivateIdentifier；字符串属性名等不在此入口处理。
 */
function identifierAtPosition(
  sf: ts.SourceFile,
  position: number,
): ts.Identifier | ts.PrivateIdentifier | undefined {
  let found: ts.Identifier | ts.PrivateIdentifier | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) &&
      position >= n.getStart(sf) &&
      position <= n.getEnd()
    ) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/* ------------------------- 导入闭包 ------------------------- */

function importClosure(
  project: VirtualProject,
  entry: string,
): Set<string> {
  const program = project.service.getProgram()!;
  const seen = new Set<string>();
  const stack = [project.normalize(entry)];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const sf = program.getSourceFile(f);
    if (!sf) continue;
    const specs: string[] = [];
    sf.forEachChild((node) => {
      if (
        ts.isImportDeclaration(node) ||
        ts.isExportDeclaration(node)
      ) {
        if (
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          specs.push(node.moduleSpecifier.text);
        }
      }
    });
    const walk = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        n.expression.kind === ts.SyntaxKind.ImportKeyword &&
        n.arguments[0] &&
        ts.isStringLiteral(n.arguments[0])
      ) {
        specs.push((n.arguments[0] as ts.StringLiteral).text);
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
    for (const spec of specs) {
      const resolved = resolveRelative(f, spec, project);
      if (resolved) stack.push(resolved);
    }
  }
  return seen;
}

function resolveRelative(
  fromFile: string,
  spec: string,
  project: VirtualProject,
): string | undefined {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return undefined;
  const dir = fromFile.slice(0, fromFile.lastIndexOf('/'));
  const base = normalizePath(`${dir}/${spec}`);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ];
  for (const c of candidates) {
    if (project.getContent(c) !== undefined) return c;
  }
  return undefined;
}

/* ------------------------- 小工具 ------------------------- */

function intervalsOverlap(
  aS: number,
  aE: number,
  bS: number,
  bE: number,
): boolean {
  return aS < bE && bS < aE;
}

const NAME_BOUNDARY = /[\p{ID_Continue}$]/u;

function matchNameWords(
  text: string,
  name: string,
): Array<{ offset: number }> {
  const out: Array<{ offset: number }> = [];
  let from = 0;
  while (from <= text.length - name.length) {
    const idx = text.indexOf(name, from);
    if (idx === -1) break;
    const before = idx === 0 ? '' : text[idx - 1];
    const after = idx + name.length >= text.length ? '' : text[idx + name.length];
    if (!NAME_BOUNDARY.test(before) && !NAME_BOUNDARY.test(after)) {
      out.push({ offset: idx });
    }
    from = idx + name.length;
  }
  return out;
}

/** 只匹配字符串引号内部（去掉首尾定界符）。 */
function matchNameInside(
  literalText: string,
  name: string,
): Array<{ offset: number }> {
  if (literalText.length < 2) return [];
  const inner = literalText.slice(1, literalText.length - 1);
  return matchNameWords(inner, name).map((m) => ({ offset: m.offset + 1 }));
}

function toSyntaxIssue(
  project: VirtualProject,
  text: string,
  fileName: string,
  d: ts.Diagnostic,
): SyntaxIssue {
  const start = d.start ?? 0;
  const length = d.length ?? 1;
  const lc = lineAndCharAt(text, start);
  const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
  return {
    fileName: project.relative(fileName),
    start,
    length,
    line: lc.line,
    startCharacter: lc.character,
    message: msg,
  };
}

function assignIds(occurrences: RenameOccurrence[]): void {
  const counts = new Map<string, number>();
  for (const o of occurrences) {
    const key = `${o.fileName}:${o.start}`;
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    o.id = `${key}#${n}`;
  }
}
