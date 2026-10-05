"use strict";
// 核心分析引擎：仅依赖 TypeScript Compiler API。
// 设计约束：
//  - 不运行任何被分析的用户代码（只做语法/语义分析）；
//  - 无网络、无后端、无 node_modules 解析，文件全部来自内存虚拟 FS；
//  - noLib：不加载内置 .d.ts，保证完全离线且结果只由工程文件决定。
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyze = analyze;
const ts = __importStar(require("typescript"));
const protocol_1 = require("../shared/protocol");
const TS_EXT = ['.ts', '.tsx', '.d.ts', '.js', '.jsx'];
function scriptKindFor(path) {
    if (path.endsWith('.tsx'))
        return ts.ScriptKind.TSX;
    if (path.endsWith('.jsx'))
        return ts.ScriptKind.JSX;
    if (path.endsWith('.js'))
        return ts.ScriptKind.JS;
    if (path.endsWith('.json'))
        return ts.ScriptKind.JSON;
    return ts.ScriptKind.TS;
}
function lineCol(sf, pos) {
    const lc = sf.getLineAndCharacterOfPosition(pos);
    return { line: lc.line + 1, col: lc.character + 1 };
}
function normalize(p) {
    const q = p.replace(/^\.\//, '').replace(/\\/g, '/');
    return q.startsWith('/') ? q : '/' + q;
}
function displayPath(p) {
    return p.replace(/^\//, '');
}
function makeService(files) {
    const data = new Map();
    for (const f of files) {
        const path = normalize(f.path);
        const sf = ts.createSourceFile(path, f.content, ts.ScriptTarget.ES2020, true, scriptKindFor(path));
        data.set(path, { path, content: f.content, rev: f.rev, sf });
    }
    const compilerOptions = {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
        // 注意：Bundler 模式下自定义 resolveModuleNameLiterals 的结果不会被 LanguageService 采用；
        // Node10 + 绝对路径可保证回调解析生效（已自测验证跨文件重命名）。
        moduleResolution: ts.ModuleResolutionKind.Node10,
        allowJs: true,
        jsx: ts.JsxEmit.Preserve,
        strict: false,
        noLib: true,
        allowNonTsExtensions: true,
        baseUrl: '.',
    };
    const versions = new Map();
    for (const f of data.values())
        versions.set(f.path, f.rev);
    const host = {
        getCompilationSettings: () => compilerOptions,
        getScriptFileNames: () => [...data.keys()],
        getScriptVersion: (fileName) => String(versions.get(normalize(fileName)) ?? 0),
        getScriptSnapshot: (fileName) => {
            const f = data.get(normalize(fileName));
            return f ? ts.ScriptSnapshot.fromString(f.content) : undefined;
        },
        getCurrentDirectory: () => '/',
        getDefaultLibFileName: () => 'lib.d.ts',
        fileExists: (fileName) => data.has(normalize(fileName)),
        readFile: (fileName) => data.get(normalize(fileName))?.content,
        readDirectory: () => [...data.keys()],
        directoryExists: (dir) => {
            const d = normalize(dir).replace(/\/$/, '');
            return [...data.keys()].some((p) => p === d || p.startsWith(d + '/'));
        },
        resolveModuleNames: (moduleNames, containingFile) => moduleNames.map((name) => resolveOne(name, containingFile)),
        // TS 5.x 对 LanguageService 走 resolveModuleNameLiterals 回调；旧回调可能不被调用
        resolveModuleNameLiterals: (moduleLiterals, containingFile) => moduleLiterals.map((lit) => {
            const resolved = resolveOne(lit.text, containingFile);
            return resolved ? { resolvedModule: resolved } : { resolvedModule: undefined };
        }),
    };
    function resolveOne(name, containingFile) {
        if (!name.startsWith('.')) {
            // 外部依赖（react 等）不解析、也不读取磁盘
            return undefined;
        }
        const dir = containingFile.split('/').slice(0, -1).join('/');
        const candidate = (dir ? dir + '/' + name : name).replace(/\/\.\//g, '/');
        for (const ext of TS_EXT) {
            const p = candidate + ext;
            if (data.has(p))
                return { resolvedFileName: p, extension: ext };
        }
        if (data.has(candidate)) {
            return { resolvedFileName: candidate, extension: '.ts' };
        }
        for (const ext of TS_EXT) {
            const p = candidate + '/index' + ext;
            if (data.has(p))
                return { resolvedFileName: p, extension: ext };
        }
        return undefined;
    }
    const service = ts.createLanguageService(host, ts.createDocumentRegistry());
    return { service, data };
}
function collectSyntaxErrors(service, data) {
    const errors = [];
    const program = service.getProgram();
    for (const f of data.values()) {
        const diags = service.getSyntacticDiagnostics(f.path);
        // 统一使用 program 内部树，保证行号与后续语义节点来自同一棵 AST
        const psf = program?.getSourceFile(f.path) ?? f.sf;
        for (const d of diags) {
            if (d.category !== ts.DiagnosticCategory.Error)
                continue;
            const start = d.start ?? 0;
            const lc = lineCol(psf, start);
            errors.push({
                file: f.path,
                start,
                startLine: lc.line,
                startCol: lc.col,
                message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
            });
        }
    }
    return errors;
}
function identifierAt(sf, pos) {
    let hit = null;
    function visit(node) {
        if (hit)
            return;
        if (ts.isIdentifier(node) && node.getStart(sf) <= pos && pos < node.getEnd()) {
            hit = node;
            return;
        }
        node.forEachChild(visit);
    }
    visit(sf);
    return hit;
}
function describeScope(sf, node, symbolKind) {
    const fileName = displayPath(sf.fileName);
    if (isPropertyNameNode(node)) {
        const owner = node.parent.parent;
        let ownerName = '<对象字面量>';
        if (ts.isInterfaceDeclaration(owner))
            ownerName = `接口 ${owner.name.text}`;
        else if (ts.isClassLike(owner))
            ownerName = `类 ${owner.name?.text ?? '<匿名>'}`;
        else if (ts.isTypeLiteralNode(owner))
            ownerName = '<对象字面量类型>';
        return `${fileName} 中 ${ownerName} 的属性 ${node.getText(sf)}`;
    }
    let cur = node;
    let func = 0;
    let block = 0;
    while (cur) {
        if (ts.isParameter(cur)) {
            const fn = ts.isFunctionLike(cur.parent) ? cur.parent : undefined;
            const fnName = fn && ts.isFunctionDeclaration(fn) && fn.name
                ? fn.name.text
                : fn && ts.isFunctionExpression(fn) && fn.name
                    ? fn.name.text
                    : '<匿名函数>';
            return `${fileName} 中函数 ${fnName} 的参数`;
        }
        if (ts.isVariableDeclaration(cur)) {
            const list = ts.isVariableDeclarationList(cur.parent) ? cur.parent : undefined;
            const kind = list && (list.flags & ts.NodeFlags.Const)
                ? 'const'
                : list && (list.flags & ts.NodeFlags.Let)
                    ? 'let'
                    : 'var';
            const inForBinding = !!(list?.parent && (ts.isForStatement(list.parent) || ts.isForInStatement(list.parent) || ts.isForOfStatement(list.parent)));
            let where = '顶层';
            if (func > 0)
                where = func === 1 ? '函数体内' : `嵌套函数（第 ${func} 层）内`;
            else if (inForBinding)
                where = 'for 循环的';
            else if (block > 0)
                where = `${block === 1 ? '' : '嵌套 '}块作用域内`;
            return `${fileName} 中 ${where} ${kind} 声明`;
        }
        if (ts.isFunctionDeclaration(cur) && cur.name)
            return `${fileName} 中函数 ${cur.name.text} 的声明`;
        if (ts.isClassDeclaration(cur))
            return `${fileName} 中类 ${cur.name?.text ?? '<匿名>'} 的${symbolKind === 'type' ? '类型' : '值'}绑定`;
        if (ts.isInterfaceDeclaration(cur))
            return `${fileName} 中接口 ${cur.name.text}`;
        if (ts.isTypeAliasDeclaration(cur))
            return `${fileName} 中类型别名 ${cur.name.text}`;
        // 计数器只对“当前节点的父节点”生效，避免把声明节点本身计入
        const parent = cur.parent;
        if (parent) {
            if (ts.isFunctionLike(parent))
                func += 1;
            if (parent.kind === ts.SyntaxKind.Block)
                block += 1;
        }
        cur = parent;
    }
    return `${fileName} 中顶层声明`;
}
function classifySymbol(symbol, declNode, checker) {
    if (symbol) {
        const flags = symbol.flags;
        if (flags & ts.SymbolFlags.Property || flags & ts.SymbolFlags.GetAccessor || flags & ts.SymbolFlags.SetAccessor || flags & ts.SymbolFlags.Method) {
            return 'property';
        }
        if (flags & ts.SymbolFlags.TypeAlias || flags & ts.SymbolFlags.Interface || flags & ts.SymbolFlags.TypeParameter) {
            return 'type';
        }
        if (flags & ts.SymbolFlags.Function)
            return 'function';
        if (flags & ts.SymbolFlags.Class) {
            // 类同时拥有类型与值两种含义；位置本身决定改的是哪一种。
            return isTypePosition(declNode, checker) ? 'type' : 'value';
        }
        if (flags & ts.SymbolFlags.Variable)
            return 'local-variable';
    }
    // PropertySignature / PropertyAssignment 等“声明名”位置上 getSymbolAtLocation 可能返回 undefined
    if (isPropertyNameNode(declNode))
        return 'property';
    return 'value';
}
function isPropertyNameNode(node) {
    const p = node.parent;
    return (!!p &&
        (ts.isPropertySignature(p) ||
            ts.isPropertyDeclaration(p) ||
            ts.isPropertyAssignment(p) ||
            ts.isMethodDeclaration(p) ||
            ts.isMethodSignature(p) ||
            ts.isEnumMember(p) ||
            ts.isShorthandPropertyAssignment(p)) &&
        p.name === node);
}
function isTypePosition(node, checker) {
    // 用 checker 的 symbolAtLocation 在类型位置上会返回仅含 Type 含义的别名符号；
    // 这里按父节点结构判断。
    let p = node.parent;
    while (p) {
        if (ts.isTypeReferenceNode(p) ||
            ts.isExpressionWithTypeArguments(p) ||
            ts.isTypeQueryNode(p) ||
            ts.isTypeOperatorNode(p)) {
            return true;
        }
        if (ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isParameter(p)) {
            return node === p.name && !!p.type && rangeContains(p.type, node);
        }
        p = p.parent;
    }
    void checker;
    return false;
}
function rangeContains(range, node) {
    return range.getStart() <= node.getStart() && node.getEnd() <= range.getEnd();
}
function makeItem(args) {
    const { fileData: f, start, end } = args;
    const sf = f.psf ?? f.sf;
    const a = lineCol(sf, start);
    const b = lineCol(sf, Math.max(start, end - 1));
    const lineStart = f.content.lastIndexOf('\n', start) + 1;
    let lineEnd = f.content.indexOf('\n', end);
    if (lineEnd < 0)
        lineEnd = f.content.length;
    const snippet = f.content.slice(lineStart, lineEnd).trim().slice(0, 120);
    return {
        file: f.path,
        start,
        end,
        startLine: a.line,
        startCol: a.col,
        endLine: b.line,
        kind: args.kind,
        status: args.status,
        scope: args.scope,
        snippet,
        prefixText: args.prefix,
        suffixText: args.suffix,
        excludedReason: args.excludedReason,
        uncertainty: args.uncertainty,
        defaultSelected: args.defaultSelected,
    };
}
/**
 * 分析入口。返回全部“可证明的改名点”、同名异绑定的排除项、
 * 字符串候选与动态访问未覆盖点，以及语法错误与版本基线。
 */
function analyze(files, triggerFile, triggerPos) {
    const triggerPath = normalize(triggerFile);
    const { service, data } = makeService(files);
    // 先拿到 program：所有节点/AST 访问统一使用 program 内部树，
    // 否则 checker 的符号表挂在内部树上，预解析树的节点取不到符号。
    const program = service.getProgram();
    for (const f of data.values()) {
        f.psf = program.getSourceFile(f.path) ?? f.sf;
    }
    const trigger = data.get(triggerPath);
    const syntaxErrors = collectSyntaxErrors(service, data);
    const baselines = {};
    for (const f of data.values())
        baselines[displayPath(f.path)] = { rev: f.rev, hash: (0, protocol_1.cyrb53)(f.content) };
    if (!trigger) {
        return {
            ok: false,
            triggerFile: displayPath(triggerPath),
            triggerPos,
            oldName: '',
            displayName: '',
            canRename: false,
            blockReason: `触发文件 ${displayPath(triggerPath)} 不在工程中`,
            items: [],
            syntaxErrors: syntaxErrors.map((e) => ({ ...e, file: displayPath(e.file) })),
            baselines,
        };
    }
    const triggerSyntaxErrors = syntaxErrors.filter((e) => e.file === triggerPath);
    if (triggerSyntaxErrors.length > 0) {
        const e = triggerSyntaxErrors[0];
        return {
            ok: false,
            triggerFile: displayPath(triggerPath),
            triggerPos,
            oldName: identifierAt(trigger.psf, triggerPos)?.text ?? '',
            displayName: '',
            canRename: false,
            blockReason: `触发文件存在语法错误（${e.startLine}:${e.startCol}）：${e.message}。已保留草稿，不做任何替换。`,
            items: [],
            syntaxErrors: syntaxErrors.map((e) => ({ ...e, file: displayPath(e.file) })),
            baselines,
        };
    }
    const checker = program.getTypeChecker();
    const renameInfo = service.getRenameInfo(triggerPath, triggerPos, {
        allowRenameOfImportPath: false,
    });
    const ident = identifierAt(trigger.psf, triggerPos);
    const oldName = ident?.text ?? (renameInfo.canRename ? renameInfo.displayName : '');
    if (!renameInfo.canRename) {
        return {
            ok: false,
            triggerFile: displayPath(triggerPath),
            triggerPos,
            oldName,
            displayName: oldName,
            canRename: false,
            blockReason: `此处无法重命名：${renameInfo.localizedErrorMessage || '该位置不是可重命名的符号（可能是关键字、字符串内容或表达式）。'}`,
            items: [],
            syntaxErrors: syntaxErrors.map((e) => ({ ...e, file: displayPath(e.file) })),
            baselines,
        };
    }
    // findInStrings/findInComments 均关闭：字符串与注释由本引擎单独扫描并降级为“需人工判断”
    const locations = service.findRenameLocations(triggerPath, triggerPos, false, false, true) ?? [];
    // 触发位置的符号（用于区分同名不同绑定）
    const triggerSymbol = ident ? checker.getSymbolAtLocation(ident) : undefined;
    const triggerSymbolKey = triggerSymbol ? symbolKey(triggerSymbol) : '';
    const triggerKind = triggerSymbol
        ? classifySymbol(triggerSymbol, ident ?? trigger.psf, checker)
        : 'value';
    const triggerScope = ident ? describeScope(trigger.psf, ident, triggerKind) : triggerPath;
    const items = [];
    const covered = [];
    for (const loc of locations) {
        const f = data.get(normalize(loc.fileName));
        if (!f)
            continue;
        const spanStart = loc.textSpan.start;
        const spanEnd = spanStart + loc.textSpan.length;
        const node = findNodeAtSpan(f.psf, spanStart, spanEnd);
        let start = spanStart;
        let end = spanEnd;
        let status = 'proven';
        let uncertainty;
        let kind = triggerKind;
        let scope = triggerScope;
        if (node && ts.isStringLiteralLike(node)) {
            // TS 给出的字符串键 span 只覆盖引号内部；getSymbolAtLocation 在整个字面量上判断
            const propSym = checker.getSymbolAtLocation(node);
            const resolves = !!propSym && !!triggerSymbol && sameSymbol(propSym, triggerSymbol);
            if (resolves) {
                status = 'proven';
                kind = 'property';
                scope = `${displayPath(f.path)} 中字符串形式的属性键（类型可解析，已证明）`;
            }
            else {
                status = 'string';
                kind = 'property';
                scope = `${displayPath(f.path)} 中字符串形式的属性键`;
                uncertainty =
                    '字符串字面量属性键：编译器无法通过文本字符串证明属性绑定（接收者类型未知），需人工确认。';
            }
            start = spanStart; // span 本就只覆盖引号内部
            end = spanEnd;
        }
        else if (node && ts.isIdentifier(node)) {
            const sym = checker.getSymbolAtLocation(node);
            if (sym) {
                kind = classifySymbol(sym, node, checker);
                scope = describeScope(f.psf, node, kind);
            }
            else if (isPropertyNameNode(node)) {
                kind = 'property';
                scope = describeScope(f.psf, node, 'property');
            }
        }
        items.push(makeItem({
            fileData: f,
            start,
            end,
            kind,
            status,
            scope,
            prefix: loc.prefixText,
            suffix: loc.suffixText,
            uncertainty,
            defaultSelected: true,
        }));
        // 覆盖区间按字符串内部记录（与扫描器口径一致）
        covered.push({ file: f.path, start: spanStart, end: spanEnd });
    }
    // 扫描：同名异绑定（排除项）、无法证明的字符串候选、动态访问未覆盖点
    scanForUncovered(data, checker, oldName, triggerSymbolKey, covered, items, service);
    // 语法错误文件中即使有 location 也标记为需复核
    if (syntaxErrors.length > 0) {
        const bad = new Set(syntaxErrors.map((e) => e.file));
        for (const it of items) {
            if (bad.has(it.file) && it.status === 'proven') {
                it.status = 'string';
                it.uncertainty = '该文件存在语法错误，语义分析结果不完整，此改动需人工确认。';
            }
        }
    }
    items.sort((a, b) => a.file === b.file ? a.start - b.start || a.end - b.end : a.file < b.file ? -1 : 1);
    // 内部虚拟 FS 使用绝对路径；对 UI/存储统一输出无 `/` 前缀的工程相对路径
    for (const it of items)
        it.file = displayPath(it.file);
    return {
        ok: true,
        triggerFile: displayPath(triggerPath),
        triggerPos,
        oldName,
        displayName: renameInfo.fullDisplayName || renameInfo.displayName,
        canRename: true,
        items,
        syntaxErrors: syntaxErrors.map((e) => ({ ...e, file: displayPath(e.file) })),
        baselines,
    };
}
function findNodeAtSpan(sf, start, end) {
    let hit = null;
    function visit(node) {
        if (hit)
            return;
        const s = node.getStart(sf);
        const e = node.getEnd();
        // 字符串键 span 只覆盖引号内部；标识符 span 与节点一致。两种都接受“节点覆盖 span”。
        if (s <= start && end <= e && (ts.isIdentifier(node) || ts.isStringLiteralLike(node))) {
            hit = node;
            return;
        }
        if (s > end)
            return;
        node.forEachChild(visit);
    }
    visit(sf);
    return hit;
}
function symbolKey(symbol) {
    // 不做 alias 解析：以声明节点身份集合作为符号指纹，
    // 属性的“接口声明”和“访问处”若指向同一成员，声明集合必有交集。
    const decls = (symbol.declarations ?? []).map((d) => {
        const sf = d.getSourceFile();
        return `${normalize(sf.fileName)}:${d.getStart(sf)}`; // 内部绝对路径即稳定指纹，不对外展示
    });
    return decls.sort().join('|') + '#' + symbol.getName();
}
function sameSymbol(a, b) {
    if (a === b)
        return true;
    const da = new Set((a.declarations ?? []).map((d) => d));
    for (const d of b.declarations ?? [])
        if (da.has(d))
            return true;
    return symbolKey(a) === symbolKey(b);
}
function isCovered(covered, file, start, end) {
    return covered.some((c) => c.file === file && !(end <= c.start || start >= c.end));
}
function scanForUncovered(data, checker, oldName, triggerSymbolKey, covered, items, service) {
    for (const f of data.values()) {
        const visit = (node) => {
            // 1) 同名标识符：若属于别的绑定/别的作用域 -> excluded
            if (ts.isIdentifier(node) && node.text === oldName) {
                const s = node.getStart(f.psf);
                const e = node.getEnd();
                if (!isCovered(covered, f.path, s, e)) {
                    const sym = checker.getSymbolAtLocation(node);
                    const key = sym ? symbolKey(sym) : undefined;
                    const kind = classifySymbol(sym, node, checker);
                    const scope = describeScope(f.psf, node, kind);
                    let reason;
                    if (!sym || key === undefined) {
                        if (kind === 'property') {
                            reason = '同名属性但无法解析其所属类型（对象字面量无上下文类型，或来自未解析依赖）：不能证明与目标属性同源，按不同符号排除。';
                        }
                        else {
                            reason = '无法解析该标识符的符号绑定，编译器未将其纳入重命名（可能来自未解析的导入或隐式全局）。';
                        }
                    }
                    else if (key !== triggerSymbolKey) {
                        reason = `同名但属于不同绑定：${scope}。按符号绑定区别处理，默认不改。`;
                    }
                    else {
                        reason = '编译器未将此处纳入重命名位置（例如仅类型层面出现的另一侧含义）。';
                    }
                    items.push(makeItem({
                        fileData: f,
                        start: s,
                        end: e,
                        kind,
                        status: 'excluded',
                        scope,
                        excludedReason: reason,
                        defaultSelected: false,
                    }));
                    covered.push({ file: f.path, start: s, end: e });
                }
            }
            // 2) 同名字符串字面量（非已覆盖）：字符串候选，无法证明绑定
            if (ts.isStringLiteralLike(node) && node.text === oldName) {
                const s = node.getStart(f.psf);
                const e = node.getEnd();
                // 已证明的字符串键覆盖区间是引号内部 s+1..e-1
                if (!isCovered(covered, f.path, s + 1, e - 1)) {
                    const inPropertyName = isPropertyNameNode(node);
                    const inAccess = ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node;
                    items.push(makeItem({
                        fileData: f,
                        start: s + 1,
                        end: e - 1,
                        kind: 'property',
                        status: 'string',
                        scope: inPropertyName ? `${displayPath(f.path)} 中对象字面量的字符串属性键` : `${displayPath(f.path)} 中字符串字面量`,
                        uncertainty: inAccess
                            ? '字符串属性访问 obj["name"]：此接收者类型无法解析，不能证明字符串指向目标属性，默认不改，需人工判断。'
                            : inPropertyName
                                ? '字符串形式的属性键，无法证明与目标属性为同一符号，需人工确认。'
                                : '普通字符串内容，通常不应随标识符重命名（如事件名、URL、字典键），需人工判断。',
                        defaultSelected: false,
                    }));
                    covered.push({ file: f.path, start: s, end: e });
                }
            }
            // 3) 动态访问未覆盖点（无法静态分析的计算属性）
            if (ts.isElementAccessExpression(node)) {
                const arg = node.argumentExpression;
                if (arg && !ts.isStringLiteralLike(arg) && !ts.isNoSubstitutionTemplateLiteral(arg)) {
                    const s = arg.getStart(f.psf);
                    const e = arg.getEnd();
                    if (!isCovered(covered, f.path, s, e)) {
                        const sym = checker.getSymbolAtLocation(node.expression);
                        const typeText = sym ? checker.typeToString(checker.getTypeOfSymbolAtLocation(sym, node.expression)) : '未知对象';
                        items.push(makeItem({
                            fileData: f,
                            start: s,
                            end: e,
                            kind: 'property',
                            status: 'string',
                            scope: `${displayPath(f.path)} 中 ${typeText} 的动态计算访问`,
                            uncertainty: '动态访问 obj[expr]：键是运行时值，静态分析无法分析其字符串内容，无法判断是否命中目标属性；列入未覆盖位置，绝不会自动修改。',
                            defaultSelected: false,
                        }));
                        covered.push({ file: f.path, start: s, end: e });
                    }
                }
            }
            // 4) 点访问但解析不出属性（对象类型未知，如来自未解析模块）
            if (ts.isPropertyAccessExpression(node) && node.name.text === oldName) {
                const s = node.name.getStart(f.psf);
                const e = node.name.getEnd();
                if (!isCovered(covered, f.path, s, e)) {
                    const sym = checker.getSymbolAtLocation(node.name);
                    const isProp = !!sym && !!(sym.flags & (ts.SymbolFlags.Property | ts.SymbolFlags.Method | ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor));
                    if (!sym || !isProp) {
                        items.push(makeItem({
                            fileData: f,
                            start: s,
                            end: e,
                            kind: 'property',
                            status: 'string',
                            scope: `${displayPath(f.path)} 中无法解析接收者类型的属性访问`,
                            uncertainty: '接收者对象的类型无法解析（可能来自未安装/未解析的依赖），编译器不能证明该属性与目标符号同源，默认不改。',
                            defaultSelected: false,
                        }));
                        covered.push({ file: f.path, start: s, end: e });
                    }
                }
            }
            node.forEachChild(visit);
        };
        visit(f.psf);
    }
    void service;
}
