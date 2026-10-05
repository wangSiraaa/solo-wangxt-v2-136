"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const run_1 = require("./run");
const { ok, checks } = (0, run_1.runSelfChecks)();
for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}\n      ${c.detail}`);
}
console.log(`\n${ok ? '全部通过' : '存在失败用例'}：${checks.filter((c) => c.pass).length}/${checks.length}`);
process.exit(ok ? 0 : 1);
