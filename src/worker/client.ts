// Worker 客户端：分析请求串行化，并支持“版本标签”——分析期间文件若再次编辑，
// 返回时可立即识别旧结果并标记过期。

import type {
  AnalyzeResult,
  SelfCheckResult,
  WorkerRequest,
  WorkerResponse,
} from '../shared/protocol';

export interface WorkerFile {
  path: string;
  content: string;
  rev: number;
}

class TsWorkerClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }>();

  private ensure(): Worker {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL('./ts.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.type === 'error') p.reject(new Error(msg.message));
      else p.resolve(msg);
    };
    this.worker.onerror = (ev) => {
      for (const [, p] of this.pending) p.reject(new Error(ev.message));
      this.pending.clear();
    };
    return this.worker;
  }

  private send(req: Omit<WorkerRequest, 'id'>): Promise<WorkerResponse> {
    const id = ++this.seq;
    const w = this.ensure();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ ...req, id });
    });
  }

  analyze(files: WorkerFile[], file: string, pos: number): Promise<AnalyzeResult> {
    return this.send({ type: 'analyze', files, file, pos } as WorkerRequest).then((r) => {
      if (r.type !== 'analyze') throw new Error('意外的 Worker 响应');
      return r;
    });
  }

  selfcheck(): Promise<SelfCheckResult> {
    return this.send({ type: 'selfcheck' } as WorkerRequest).then((r) => {
      if (r.type !== 'selfcheck') throw new Error('意外的 Worker 响应');
      return r;
    });
  }
}

export const tsWorker = new TsWorkerClient();
