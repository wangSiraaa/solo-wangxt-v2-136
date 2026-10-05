import { runSelfChecks } from './run';

declare const console: { log: (...args: unknown[]) => void };
declare const process: { exit: (code: number) => void };

const { ok, checks } = runSelfChecks();
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}\n      ${c.detail}`);
}
console.log(`\n${ok ? '全部通过' : '存在失败用例'}：${checks.filter((c) => c.pass).length}/${checks.length}`);
process.exit(ok ? 0 : 1);
