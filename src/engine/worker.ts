import ts from 'typescript';
import { VirtualProject } from './virtualProject';
import { analyzeRename } from './analyzer';
import type {
  WorkerRequest,
  WorkerResponse,
} from './types';

/**
 * Worker 入口：TypeScript Compiler API 只在此线程加载，
 * 主线程永不 import typescript，也不执行被分析工程的任何代码。
 */
let project: VirtualProject | null = null;

function post(msg: WorkerResponse): void {
  (self as unknown as Worker).postMessage(msg);
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    switch (req.type) {
      case 'init': {
        project = new VirtualProject(
          req.snapshot.files.map((f) => ({
            path: f.path,
            content: f.content,
          })),
        );
        void ts; // 确保编译器仅被 Worker 引用
        post({ type: 'ready' });
        break;
      }
      case 'updateFile': {
        project?.upsert(req.path, req.content);
        break;
      }
      case 'analyze': {
        if (!project) throw new Error('引擎尚未初始化');
        const result = analyzeRename(project, {
          baseVersions: req.input.baseVersions,
          fileName: req.input.fileName,
          position: req.input.position,
          oldName: req.input.oldName,
        });
        post({ type: 'analyzeResult', requestId: req.requestId, result });
        break;
      }
    }
  } catch (err) {
    post({
      type: 'error',
      requestId: 'requestId' in req ? req.requestId : undefined,
      message: err instanceof Error ? err.stack ?? err.message : String(err),
    });
  }
};
