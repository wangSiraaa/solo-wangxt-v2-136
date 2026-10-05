/// <reference lib="webworker" />
// TypeScript Compiler API 所在 Worker：
// 主线程把整个工程的文件快照发进来，Worker 构建内存 LanguageService。
// 不 fetch、不 import() 用户代码、不访问任何外部资源。

import { analyze } from '../engine/engine';
import { runSelfChecks } from '../selftest/run';
import type { WorkerRequest, WorkerResponse } from '../shared/protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    if (req.type === 'analyze') {
      const result = analyze(
        req.files.map((f) => ({ path: f.path, content: f.content, rev: f.rev })),
        req.file,
        req.pos,
      );
      const res: WorkerResponse = { type: 'analyze', id: req.id, ...result };
      ctx.postMessage(res);
    } else if (req.type === 'selfcheck') {
      const res: WorkerResponse = { type: 'selfcheck', id: req.id, ...runSelfChecks() };
      ctx.postMessage(res);
    }
  } catch (err) {
    ctx.postMessage({
      type: 'error',
      id: req.id,
      message: err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err),
    } satisfies WorkerResponse);
  }
};
