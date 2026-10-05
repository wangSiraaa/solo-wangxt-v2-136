import ts from 'typescript';

/**
 * 内存中的 TypeScript 工程：
 * - 只实现 LanguageService 所需的最小 Host；
 * - 文件内容全部驻留内存，不读磁盘、不执行任何被分析的代码、没有后端；
 * - 每个文件带版本号，内容不变则版本不变，供增量分析与过期检测。
 */

const ROOT = '/project';

export interface InputFile {
  path: string;
  content: string;
}

export class VirtualProject {
  private files = new Map<
    string,
    { content: string; version: number }
  >();

  readonly compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    allowJs: false,
    // 不注入默认 lib：保持纯内存、离线可复现；缺 DOM 等全局类型
    // 只影响全局变量的类型信息，不影响本地/跨模块的重命名绑定。
    noLib: true,
    strict: true,
    skipLibCheck: true,
    allowNonTsExtensions: true,
  };

  readonly service: ts.LanguageService;

  constructor(initial: InputFile[] = []) {
    for (const f of initial) this.upsert(f.path, f.content);

    const self = this;
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => [...self.files.keys()],
      getScriptVersion: (fileName) =>
        self.files.get(self.normalize(fileName))?.version.toString() ?? '0',
      getScriptSnapshot: (fileName) => {
        const entry = self.files.get(self.normalize(fileName));
        return entry
          ? ts.ScriptSnapshot.fromString(entry.content)
          : undefined;
      },
      getCurrentDirectory: () => ROOT,
      getCompilationSettings: () => self.compilerOptions,
      getDefaultLibFileName: () => '',
      fileExists: (fileName) => self.files.has(self.normalize(fileName)),
      readFile: (fileName) =>
        self.files.get(self.normalize(fileName))?.content,
      readDirectory: () => [...self.files.keys()],
      directoryExists: (dir) =>
        [...self.files.keys()].some((p) =>
          p.startsWith(normalizePath(`${ROOT}/${dir}`) + '/'),
        ),
      getDirectories: () => [],
      // 纯内存的相对模块解析：只解析工程内的 ./ ../ 文件，
      // 不碰 node_modules，保证跨文件重命名的符号绑定成立。
      resolveModuleNames: (moduleNames, containingFile) =>
        moduleNames.map((spec) => {
          const resolved = resolveInMemory(spec, containingFile, self);
          if (!resolved) return undefined;
          return {
            resolvedFileName: resolved,
            extension: resolved.endsWith('.tsx')
              ? ts.Extension.Tsx
              : ts.Extension.Ts,
            isExternalLibraryImport: false,
          };
        }),
    };
    this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  /** 相对路径（src/a.ts）→ 工程内绝对路径（/project/src/a.ts）。 */
  normalize(p: string): string {
    if (p.startsWith(ROOT + '/') || p === ROOT) return p;
    return normalizePath(`${ROOT}/${p.replace(/^\.?\//, '')}`);
  }

  /** /project/src/a.ts -> src/a.ts（展示用）。 */
  relative(p: string): string {
    const norm = this.normalize(p);
    return norm.slice(ROOT.length + 1);
  }

  getFileNames(): string[] {
    return [...this.files.keys()];
  }

  getContent(fileName: string): string | undefined {
    return this.files.get(this.normalize(fileName))?.content;
  }

  upsert(path: string, content: string): string {
    const key = this.normalize(path);
    const existing = this.files.get(key);
    if (existing?.content === content) return key;
    this.files.set(key, {
      content,
      version: existing ? existing.version + 1 : 0,
    });
    return key;
  }
}

/** 去掉 `./`、解析 `../`，统一分隔符。 */
export function normalizePath(p: string): string {
  const isAbs = p.startsWith('/');
  const parts = p.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length && stack[stack.length - 1] !== '..') stack.pop();
      else if (!isAbs) stack.push('..');
      continue;
    }
    stack.push(part);
  }
  return (isAbs ? '/' : '') + stack.join('/');
}

function resolveInMemory(
  spec: string,
  containingFile: string,
  project: VirtualProject,
): string | undefined {
  if (!spec.startsWith('.') && !spec.startsWith('/')) return undefined;
  const dir = containingFile.slice(0, containingFile.lastIndexOf('/'));
  const base = normalizePath(`${dir}/${spec}`);
  for (const c of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (project.getContent(c) !== undefined) return c;
  }
  return undefined;
}
