import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// TypeScript 编译器整体运行于 Worker 中（见 src/engine/worker.ts），
// 主线程代码从不导入 typescript，也不会执行被分析工程的任何代码。
export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
  },
});
