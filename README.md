# Rename Studio — 逐处确认的 TypeScript 重命名预览工具

把 IDE 风格的“重命名”做成开发者**逐处确认**的浏览器工具。每一处同名文本都必须
凭**符号绑定**区别对待；动态访问无法分析时**列出未覆盖位置**；语法错误时
**保留草稿、绝不全文盲替**。

- React 18 + Monaco（编辑器 UI）+ Vite
- TypeScript Compiler API 完全运行在 **Web Worker** 中（`src/engine/worker.ts`）
- 文件与操作历史持久化在 **IndexedDB**（`src/state/db.ts`）
- 不运行被导入工程的任何代码、不读磁盘、**无后端**

## 快速开始

```bash
npm install
npm run dev      # 开发
npm test         # 18 个分析/闸门/种子工程测试
npm run build    # 类型检查 + 生产构建
```

打开后左侧“验证指引”页内置了一套刻意覆盖边界情况的小型工程。

## 命中的五种置信分类

| 分类 | 颜色 | 含义 | 默认处理 |
| --- | --- | --- | --- |
| `proven` | 绿 | TypeScript 符号绑定证明属于目标符号 | 勾选，可替换 |
| `otherBinding` | 橙 | 同名但绑定到**另一个**符号（遮蔽 / 类型与值同名 / 无关属性） | 不可勾选 |
| `stringText` | 黄 | 字符串、模板静态文本、JSX 文本中的同名片段 | 不替换，人工判断 |
| `dynamic` | 红 | `obj[expr]`、`for...in`、`Object.keys/entries` 等无法证明的动态访问 | 列为未覆盖位置，**逐条人工确认** |
| `comment` | 灰 | 注释中的同名文本 | 原样保留 |

### 类型与值同名的特殊处理

`findRenameLocations` 对 `interface X` 与 `function X` 同名会**合并两个空间**
的引用。本工具额外按“触发声明所在空间（type / value）”过滤编译器结果：
从接口名发起只改类型引用，从函数名发起只改值引用；被排除的另一空间位置
明确显示为“同名但处于另一绑定空间”。见 `src/engine/analyzer.ts` 的
`locationSpace` / `declarationSpace`。

## 安全闸门（提交前）

`src/engine/gate.ts` 只有在以下条件**全部**满足时才允许进入复核：

1. 分析状态为 `ok`（无语法错误、位置可重命名）；
2. 新名称是合法标识符且与旧名不同；
3. **共同版本一致**：分析时的每个文件版本 == 编辑器当前版本
   （分析期间再次编辑 → 立即“预览已过期”，提交锁定，须重新分析）；
4. 至少勾选一处已证明命中；
5. 所有 `dynamic` 未覆盖位置都已被逐条确认“已人工处理”。

复核弹窗逐文件展示行级 diff（仅已证明的改动）、写入文件清单与
未覆盖位置数量，确认后**整次操作原子提交**。

## 整次操作撤销

一次重命名（可能跨多文件）记录为一条历史：提交前所有受影响文件的完整内容
存入 IndexedDB。撤销时把这些文件**整体恢复**到操作前版本（不是逐行补丁），
若操作之后文件又被修改会先提示冲突。见 `commitOperation` / `restoreOperation`。

## 格式保留

编辑生成（`src/engine/renameBuilder.ts` + `src/engine/edit.ts`）只替换
勾选区间，自后向前应用偏移；区间之外的注释、空白、引号风格逐字保留。
简写属性的 prefix/suffix 直接采用 TypeScript 返回的文本（其中含旧名），
避免破坏对象形状。

## 目录

```
src/engine/
  virtualProject.ts  内存 LanguageServiceHost（含相对模块解析，无磁盘/网络）
  analyzer.ts        符号绑定分类、字符串/注释/动态访问扫描、空间过滤
  renameBuilder.ts   已确认命中 -> 编辑（含 prefix/suffix）
  edit.ts            偏移替换 + LCS 行级 diff
  gate.ts            提交闸门
  version.ts         内容指纹（过期检测）
  worker.ts          Worker 入口（唯一 import typescript 的地方）
  engineClient.ts    主线程 Worker 客户端
src/state/
  db.ts              IndexedDB：文件 + 整次操作历史
  studio.ts          React 状态、分析/提交/撤销编排
src/ui/              Monaco 面板、逐处确认侧栏、复核弹窗、历史侧栏
src/seed/            内置验证工程
tests/               引擎与种子工程回归测试
```

## 已验证的场景（见 tests/ 与“验证指引”页）

- 变量遮蔽：外层参数/变量与内层同名绑定互不联动；
- 类型与值同名：interface/function、type/const 各自独立的命中集合；
- 对象属性：点访问与字面量键已证明，`obj[expr]`/`Object.keys`/`for...in`
  列为未覆盖；字符串与注释分类保留；
- 跨文件导入重命名（内存模块解析）；
- 语法错误：目标文件与导入闭包阻断且无命中，闭包外仅警告，草稿保留；
- 分析期间再次编辑：版本不一致即拒绝提交；
- 简写属性重命名保持对象形状；
- 整次操作撤销恢复全部涉及文件。
