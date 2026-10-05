import type {
  ProjectSnapshot,
  RenameAnalysisInput,
  RenameAnalysisResult,
  WorkerResponse,
} from './types';

/**
 * 主线程侧的引擎客户端：封装 Worker 通信。
 * 文件更新以“尽力同步”的防抖方式推给 Worker，
 * 分析请求总会先 flush，保证分析基于最新草稿。
 */
export class EngineClient {
  private worker: Worker;
  private ready: Promise<void>;
  private seq = 0;
  private pending = new Map<
    number,
    {
      resolve: (r: RenameAnalysisResult) => void;
      reject: (e: Error) => void;
    }
  >();
  private flushTimer: number | undefined;
  private queuedUpdates: Array<{
    path: string;
    content: string;
    version: string;
  }> = [];

  constructor(snapshot: ProjectSnapshot) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
    });
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('分析引擎启动超时')),
        30000,
      );
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data;
        if (msg.type === 'ready') {
          clearTimeout(timer);
          resolve();
        } else if (msg.type === 'analyzeResult') {
          this.pending.get(msg.requestId)?.resolve(msg.result);
          this.pending.delete(msg.requestId);
        } else if (msg.type === 'error') {
          const err = new Error(msg.message);
          if (msg.requestId !== undefined) {
            this.pending.get(msg.requestId)?.reject(err);
            this.pending.delete(msg.requestId);
          } else {
            // eslint-disable-next-line no-console
            console.error('worker error:', err);
          }
        }
      };
      this.worker.onerror = (e) =>
        reject(new Error(`Worker 错误：${e.message}`));
      this.worker.postMessage({ type: 'init', snapshot });
    });
  }

  /** 防抖推送文件变更（50ms 合并连续键入）。 */
  updateFile(path: string, content: string, version: string): void {
    this.queuedUpdates = this.queuedUpdates.filter((u) => u.path !== path);
    this.queuedUpdates.push({ path, content, version });
    window.clearTimeout(this.flushTimer);
    this.flushTimer = window.setTimeout(() => this.flush(), 50);
  }

  private flush(): void {
    const updates = this.queuedUpdates;
    this.queuedUpdates = [];
    for (const u of updates) {
      this.worker.postMessage({ type: 'updateFile', ...u });
    }
  }

  async analyze(input: RenameAnalysisInput): Promise<RenameAnalysisResult> {
    await this.ready;
    this.flush();
    const requestId = ++this.seq;
    return await new Promise<RenameAnalysisResult>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage({
        type: 'analyze',
        requestId,
        input,
      });
    });
  }

  dispose(): void {
    this.worker.terminate();
  }
}
