# 为什么直接 `bun build` 会报 `@opentui/solid/jsx-runtime` 导出缺失

## 现象

对任意含 JSX 的 TUI 源文件直接执行：

```bash
bun build terminal/packages/tui/src/providers/helper.tsx --target=bun --outfile=/tmp/out.js
```

报错（在**未改动的文件**上同样复现）：

```
error: No matching export in ".../@opentui/solid/jsx-runtime.d.ts" for import "jsxDEV"
```

而官方构建 `bun run build:terminal:tui` **完全正常**。

## 原因

两条 JSX 编译路径不同：

| | 直接 `bun build` | 官方构建 `scripts/build.ts` |
|---|---|---|
| JSX 由谁转换 | bun 内置 TSX loader | `babel-preset-solid`（构建期，`generate: "universal"`） |
| 产出的 import | `@opentui/solid/jsx-runtime`（取 `jsx` / `jsxDEV` / `Fragment`） | `@opentui/solid`（取 `createElement` / `spread` / `insert`） |
| 结果 | 落到坏的入口 → 失败 | 落到 `index.js` → 成功 |

直接 `bun build` 时，bun 按 `bunfig.build.toml` 里的 `jsxImportSource = "@opentui/solid"` 生成 `@opentui/solid/jsx-runtime` 的导入。而该包的 `exports` 是：

```json
"./jsx-runtime": "./jsx-runtime.d.ts",
"./jsx-dev-runtime": "./jsx-runtime.d.ts"
```

`jsx-runtime.d.ts` **只声明 JSX 命名空间的类型，没有任何运行时导出**（没有 `jsx`、`jsxs`、`jsxDEV`、`Fragment`）。包里也不存在 `jsx-runtime.js`。

这不是本仓库改坏的文件，是上游的包设计：**该包不提供自动 JSX runtime，必须由 `babel-preset-solid` 在构建期转换**。

官方 `scripts/build.ts` 正是这么做的 —— 它注册 `onLoad({ filter: /\.(js|ts)x$/ })`，用 babel + `babel-preset-solid`（`generate: "universal"`）把 `.tsx` 转成 `js` loader。因此 bun 的 TSX loader 从不接管这些文件，也就不会生成 `jsx-runtime` 导入。

## 因此

- 这**不是**回归，也**不是**某次改动引入的。从引入 `@opentui/solid` 起就如此（`bunfig.build.toml` 首次提交 `4597dd0`，2026-05-24）。
- 之前没遇到，是因为没人直接用 `bun build` 编 TUI 源文件 —— 都走官方脚本。
- 它只影响「临时用 `bun build` 做单文件检查」这类侧路，不影响产品构建与测试。测试走 `--preload ./src/entry/preload.ts`，该 preload 会装上 solid 转换插件。

## 怎么正确做单文件检查

不要用裸 `bun build`。可选：

1. **跑测试（推荐）**

   ```bash
   bun test --preload <abs>/terminal/packages/tui/src/entry/preload.ts <testfile>
   ```

   preload 已装插件，JSX 正常转换；而且验证的是真实运行路径。

2. **跑官方构建**

   ```bash
   bun run build:terminal:tui
   ```

   全量构建，成功即说明源文件可编译。

3. 若确实需要单独打包某文件，**复用官方插件**：`Bun.build({ plugins: [<build.ts 里的 solidTransformPlugin>] })`，而不是 `bun build` CLI。

注意：`--preload` 不能与 `bun build` 子命令连用（会被当成第二个 entry point 而报 `Must use --outdir`），所以第 3 条必须走 `Bun.build` API。

## 是否可以根治

可以让裸 `bun build` 也能工作，办法是给 `@opentui/solid` 补一个真正的 JSX runtime 入口。但**不建议**：

- 需要改 `node_modules`（会被重装覆盖），或加 patch / override —— 都是维护负担；
- 上游可能在未来版本补上该入口，届时冲突；
- 收益仅是「临时检查方便」，而正确做法（跑测试或官方构建）本来就更好 —— 它验证的是真实构建路径。

结论：**保持现状，用官方构建 / 测试做验证**。本文档的目的是让下一个人不再把它误判成回归。
