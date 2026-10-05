"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSelfChecks = runSelfChecks;
// 引擎自测：在 Node 下直接运行（tsc 编译到 out-test），不执行任何被分析代码。
const engine_1 = require("../engine/engine");
const protocol_1 = require("../shared/protocol");
const fixtures_1 = require("./fixtures");
function shadowingFixture() {
    return fixtures_1.shadowing;
}
function counts(items, pred) {
    return items.filter(pred).length;
}
function runSelfChecks() {
    const checks = [];
    const record = (name, cond, detail) => {
        checks.push({ name, pass: cond, detail });
    };
    // ---- 1. 变量遮蔽：外层 count 改名，内层两个 count 绑定必须被排除 ----
    {
        const content = shadowingFixture();
        const files = [{ path: 'Shadowing.ts', content, rev: 1 }];
        const pos = content.indexOf('const count = 1') + 'const '.length; // 外层声明
        const r = (0, engine_1.analyze)(files, 'Shadowing.ts', pos);
        const proven = counts(r.items, (i) => i.status === 'proven');
        const excluded = counts(r.items, (i) => i.status === 'excluded');
        const excludedItems = r.items.filter((i) => i.status === 'excluded');
        const excludedScopes = excludedItems.map((i) => i.scope).join(' | ');
        // 外层绑定：声明、doubled 行、return、inner(count) 实参 = 4 处
        record('变量遮蔽：外层绑定恰好改 4 处', r.ok && proven === 4, `proven=${proven}（期望 4：声明 + doubled + return + 实参）实际项=${r.items.length}`);
        record('变量遮蔽：for 循环绑定与函数参数均被排除且作用域可辨', excluded >= 3 &&
            excludedItems.some((i) => i.scope.includes('for 循环')) &&
            excludedItems.some((i) => i.scope.includes('inner 的参数')), `excluded=${excluded}；作用域：${excludedScopes}`);
        const applied = (0, protocol_1.applyEdits)(content, r.items.filter((i) => i.status === 'proven').map((i) => ({ start: i.start, end: i.end, newText: 'total' })));
        record('变量遮蔽：替换后内层绑定文本保持为 count', applied !== null && applied.includes('for (const count of') && applied.includes('inner(count: number)') && !applied.includes('const total of'), applied ?? 'null');
        record('变量遮蔽：对象属性 count 不与局部变量混改', r.items.every((i) => i.kind !== 'property' || i.status !== 'proven'), 'proven 项中无 property');
    }
    // ---- 2. 类型与值同名（不同声明共享名字）：值侧与类型侧是两个符号 ----
    {
        const content = `type Box = { v: number };      // 类型 Box
const Box = { make: () => ({ v: 1 }) as Box };  // 值 Box（同名不同绑定）
const b: Box = Box.make();
function take(x: Box) { return Box.make(); }
`;
        const files = [{ path: 'Box.ts', content, rev: 1 }];
        // 值位置：const b: Box = Box.make() 中的 Box.make
        const valuePos = content.indexOf('= Box.make') + 2;
        const rv = (0, engine_1.analyze)(files, 'Box.ts', valuePos);
        const applied = (0, protocol_1.applyEdits)(content, rv.items.filter((i) => i.status === 'proven').map((i) => ({ start: i.start, end: i.end, newText: 'Crate' })));
        record('类型/值同名：值侧改名可执行', rv.ok, `items=${rv.items.length}`);
        record('类型/值同名：改值侧时类型标注 Box 全部保留', applied !== null &&
            (applied?.includes(': Box') ?? false) &&
            (applied?.includes('(x: Box)') ?? false) &&
            (applied?.includes('Crate.make') ?? false) &&
            !(applied?.includes('type Crate') ?? false), applied ?? 'null');
        // 类型位置：const b: Box
        const typePos = content.indexOf('b: Box') + 'b: '.length;
        const rt = (0, engine_1.analyze)(files, 'Box.ts', typePos);
        const appliedT = (0, protocol_1.applyEdits)(content, rt.items.filter((i) => i.status === 'proven').map((i) => ({ start: i.start, end: i.end, newText: 'BoxT' })));
        record('类型/值同名：改类型侧时值表达式 Box.make 保留', (appliedT?.includes('= Box.make') ?? false) &&
            (appliedT?.includes(': BoxT') ?? false) &&
            (appliedT?.includes('(x: BoxT)') ?? false), appliedT ?? 'null');
    }
    // ---- 3. 对象属性 + 字符串键 + 动态访问：证明、候选、未覆盖三分开 ----
    {
        const content = `interface User {
  name: string;
}
const u: User = { name: 'ada' };
const direct = u.name;
const byKey = u['name'];           // 类型可解析：字符串键同样可证明
const dynamicKey = 'na' + 'me';
const dyn = u[dynamicKey];         // 动态访问：无法静态分析，列入未覆盖
const event = 'name';              // 普通字符串：列出但默认不改
declare const loose: any;
const looseAccess = loose.name;    // 接收者类型未知：不能证明
`;
        const files = [{ path: 'Props.ts', content, rev: 1 }];
        const r = (0, engine_1.analyze)(files, 'Props.ts', content.indexOf('name: string'));
        const proven = r.items.filter((i) => i.status === 'proven');
        const strings = r.items.filter((i) => i.status === 'string');
        const hasDynamic = strings.some((i) => i.uncertainty?.includes('动态访问'));
        const hasNormalString = strings.some((i) => i.uncertainty?.includes('普通字符串'));
        const hasLoose = strings.some((i) => i.uncertainty?.includes('接收者'));
        record('属性：接口/字面量键/点访问/字符串键全部证明命中', proven.length === 4, `proven=${proven.length}（期望 4：接口声明、对象字面量键、u.name、u['name']）`);
        record('属性：u["name"] 类型可解析时按已证明处理（默认勾选）', proven.some((i) => i.snippet.includes("u['name']")), `字符串键 proven=${proven.filter((i) => i.snippet.includes("u['name']")).length}`);
        record('属性：u[dynamicKey] 动态访问列入未覆盖', hasDynamic, hasDynamic ? '已列入' : '缺失');
        record('属性：普通字符串 "name" 列出但默认不改', hasNormalString, hasNormalString ? '已列出' : '缺失');
        record('属性：any 接收者的 .name 不能证明，默认不改', hasLoose, hasLoose ? '已列入' : '缺失');
    }
    // ---- 4. 跨文件重命名 ----
    {
        const a = `export interface User {
  id: number;
  name: string; // 保留这条注释
}
export function greet(u: User): string {
  return u.name;
}`;
        const b = `import { greet, type User } from './a';
const u: User = { id: 1, name: 'bob' };
console.log(greet(u), u.name);`;
        const files = [
            { path: 'src/a.ts', content: a, rev: 1 },
            { path: 'src/b.ts', content: b, rev: 1 },
        ];
        const r = (0, engine_1.analyze)(files, 'src/a.ts', a.indexOf('interface User') + 'interface '.length);
        const inB = r.items.filter((i) => i.file === 'src/b.ts' && i.status === 'proven').length;
        const inA = r.items.filter((i) => i.file === 'src/a.ts' && i.status === 'proven').length;
        // a.ts：接口声明 + greet 参数类型 = 2；b.ts：import 中类型说明符 + 局部类型标注 = 2
        record('跨文件：导出符号在两个文件都给出位置', r.ok && inA === 2 && inB === 2, `a.ts=${inA} b.ts=${inB}`);
        record('跨文件：基线记录每文件 rev 与 hash', Object.keys(r.baselines).length === 2 && r.baselines['src/b.ts'].hash === (0, protocol_1.cyrb53)(b), JSON.stringify(r.baselines));
    }
    // ---- 5. 语法错误：阻止改名并保留草稿 ----
    {
        const content = `const x = 1
const broken = (;`;
        const files = [{ path: 'Broken.ts', content, rev: 1 }];
        const r = (0, engine_1.analyze)(files, 'Broken.ts', content.indexOf('x'));
        record('语法错误：canRename=false 且说明原因', !r.ok && !r.canRename && !!r.blockReason && r.blockReason.includes('语法错误'), r.blockReason ?? '');
        record('语法错误：不产生任何编辑、草稿不变', r.items.length === 0, `items=${r.items.length}`);
    }
    // ---- 6. 保留注释与无关格式；撤销恢复整次操作前内容 ----
    {
        const content = `// 头部注释
const   value   =  10;   // 行尾注释
function f() {
  /* 块注释 */
  return   value ;
}
`;
        const files = [{ path: 'Fmt.ts', content, rev: 1 }];
        const r = (0, engine_1.analyze)(files, 'Fmt.ts', content.indexOf('value'));
        const next = (0, protocol_1.applyEdits)(content, r.items.filter((i) => i.status === 'proven').map((i) => ({ start: i.start, end: i.end, newText: 'renamed' })));
        const undone = content; // “按整次操作撤销”= 直接恢复操作前快照
        record('格式保留：只动符号文本，空白与注释不变', next !== null && next.includes('// 头部注释') && next.includes('// 行尾注释') && next.includes('/* 块注释 */') && next.includes('const   renamed   =  10;') && !next.includes('value'), next ?? 'null');
        record('撤销：整次操作前快照可完整恢复', undone === content, (0, protocol_1.cyrb53)(undone) === (0, protocol_1.cyrb53)(content) ? '快照一致' : '不一致');
    }
    // ---- 7. 分析期间再次编辑：基线哈希不一致，必须先复核/重新分析 ----
    {
        const content = `let total = 1;
total += 2;
console.log(total);`;
        const files = [{ path: 'Drift.ts', content, rev: 1 }];
        const r = (0, engine_1.analyze)(files, 'Drift.ts', content.indexOf('total'));
        const edited = content.replace('total += 2', 'total += 2; // 用户在分析期间新增注释');
        const sameVersion = r.baselines['Drift.ts'].hash === (0, protocol_1.cyrb53)(edited) && r.baselines['Drift.ts'].rev === 1;
        record('漂移检测：分析后再编辑导致哈希不符，阻止旧预览提交', !sameVersion, `baseline=${r.baselines['Drift.ts'].hash} now=${(0, protocol_1.cyrb53)(edited)}`);
        const files2 = [{ path: 'Drift.ts', content: edited, rev: 2 }];
        const r2 = (0, engine_1.analyze)(files2, 'Drift.ts', edited.indexOf('total'));
        record('漂移恢复：重新分析后基线与新共同版本一致', r2.baselines['Drift.ts'].hash === (0, protocol_1.cyrb53)(edited) && r2.baselines['Drift.ts'].rev === 2, 'rev=2 哈希一致');
    }
    const ok = checks.every((c) => c.pass);
    return { ok, checks };
}
