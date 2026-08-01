## 上下文
`terminal/packages` 的现有拆分体现出明确边界：`core` 承载协议和类型，`organ` 承载运行时和领域逻辑，`organ-support` 承载项目/headless 支撑，`cli` 承载外部命令入口，`tui` 承载交互式 UI。当前 TUI 子包内部没有保持同样的分层，导致维护时难以判断代码属于通用 UI、TuiA1 具体产品实现、runtime adapter，还是启动 glue。

## 方案概览
1. 采用责任优先的目录结构。
   - `entry/`：包入口、CLI bridge、thread command、preload、TuiA1 main。
   - `runtime/`：TUI runtime facade、catalog、mock、bridge。
   - `app/tui_a1/`：当前 TuiA1 具体 app，包含 features、providers、state、route、shell、perf。
   - `ui/`：可复用 OpenTUI/Solid UI 组件、dialog、primitive、toast、selection。
   - `providers/`：跨 app 的通用 provider。
   - `commands/`：命令 catalog 和 command dialog glue。
   - `support/`：非 UI 工具、CLI support、filesystem、logging、diagnostics、global、installation、lsp 等。
2. 分层依赖方向。
   - `app/tui_a1` 可以依赖 `ui`、`providers`、`runtime`、`support`。
   - `ui` 不依赖 `app/tui_a1`。
   - `providers` 不依赖具体 app；若依赖 TuiA1 sync state，则移入 `app/tui_a1/providers`。
   - `runtime` 不依赖 UI 组件。
   - `support` 尽量不依赖 UI。
3. 去除 alias 和兼容残留。
   - 迁移过程中可以短暂使用局部中间步骤，但最终 phase 必须删除 TUI-local alias 用法和迁移-only barrel。
   - `tsconfig.json` 中的 TUI-local path alias 需要随最终清理同步删除或收窄到非源码使用场景。
4. 未使用功能清单。
   - 创建 track-local inventory 文档，记录疑似未启用功能、入口、引用链、保留/删除建议、验证结果。
   - LSP 是首个必须登记的候选项。
5. 大文件拆分。
   - 将 `tui_a1/index.tsx` 拆成 app root、view/layout、runtime effects、dialog wiring 或 feature gateway。
   - 拆分以行为保持为前提，不混入 UI redesign。

## 目标目录草案
```text
terminal/packages/tui/src/
  entry/
  runtime/
  app/
    tui_a1/
      features/
      providers/
      state/
      route/
      shell/
      perf/
  ui/
    dialog/
    primitives/
    toast/
    selection/
  providers/
  commands/
  support/
  types/
```

## 影响范围与修改点（Impact）
- `terminal/packages/tui/src/tui_a1/**`
- `terminal/packages/tui/src/ui/**`
- `terminal/packages/tui/src/component/**`
- `terminal/packages/tui/src/context/**`
- `terminal/packages/tui/src/runtime/**`
- `terminal/packages/tui/src/support/**`
- `terminal/packages/tui/src/index.ts`
- `terminal/packages/tui/src/thread.ts`
- `terminal/packages/tui/src/tui_a1-main.ts`
- `terminal/packages/tui/tsconfig.json`
- `terminal/packages/tui/package.json`

## 决策摘要
- 使用 `tui_a1` / `TuiA1` / `tuiA1` 命名保持未来变种区分。
- 最终不保留 import alias。
- 明显未启用功能先记录收集，最后再决定删除、保留或迁移。
- 先做包内重组，跨包抽离 runtime facade 作为后续可选事项。

## 风险 / 权衡
- 大规模移动文件可能引入 import 错误 -> 分阶段迁移并每阶段运行测试和 alias/import 扫描。
- 去除 alias 后相对路径可能变长 -> 通过合理目录层次和局部 index 文件控制深度，但最终不保留迁移-only re-export。
- 删除未启用功能可能误删未来能力 -> 必须先登记 inventory 并给出证据。
- 拆分 TuiA1 root 可能影响 streaming 或 dialog 行为 -> 先加/保留针对性测试，再进行结构移动。

## 迁移计划
1. 建立 inventory 和目标目录骨架。
2. 迁移 entry/runtime/support 的边界，修复直接源码包引用。
3. 迁移 reusable UI 和 providers，解除通用层对 TuiA1 的反向依赖。
4. 迁移 TuiA1 features/system/state/route，消除 `materials` 命名。
5. 拆分 TuiA1 root 文件。
6. 删除 aliases、兼容 shims、空目录和未保留功能。
7. 运行测试、type/import 扫描和手工 smoke 验证。

## 待解决问题
- LSP 是否作为未来功能保留，还是在本轮删除。
- Runtime facade 是否在后续 track 中抽离到 `organ-support` 或独立 package。
