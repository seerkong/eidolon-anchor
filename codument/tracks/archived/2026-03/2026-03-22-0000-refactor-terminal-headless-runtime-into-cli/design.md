## 上下文

原 `-T` 链路曾经验证可用于：

- 单轮直接输出
- 脚本式调用
- 后续 serve / MCP / attach 模式的基础能力

但这条链路仍放在 `terminal/packages/tui/src/cli/cmd/tui/thread.ts` 中，不利于后续无头 terminal 产品面扩展。

## 目标

- 让 `terminal/packages/cli` 成为无头 terminal 能力的承载包
- 让无头 runtime 不再绑定 `tui` 入口文件
- 让项目根解析与无头 turn 执行形成稳定可测的公共逻辑

## 方案概览

### 1. 运行时下沉到 `terminal/packages/organ`

把当前 `tui/runtime/TuiRuntime.ts` 中真正与 session runtime 相关的逻辑抽到 `terminal/packages/organ`。

TUI 包只保留：

- OpenTUI 页面
- TUI facade
- 针对 TUI 的适配封装

### 2. 入口共享能力放到 `terminal/packages/support`

将以下逻辑放入 `support`：

- 项目根目录解析
- prompt/stdin 归一化
- 无头 turn 执行 helper

这样 `cli` 与 `tui` 都可以直接复用。

### 3. `cli` 提供无头 run 命令

在 `terminal/packages/cli` 中提供新的无头命令，例如：

- `run [project]`

它负责：

- 解析项目目录
- 配置 runtime
- 读取 prompt / stdin
- 输出 turn 结果

## 风险 / 权衡

- 运行时文件从 `tui` 挪到 `organ`，会带来 import 面调整
- 兼容既有脚本的成本会持续放大入口职责，因此最终应移除 `tui -T`，只保留 `cli run` 作为无头入口

## 迁移策略

1. 先抽 runtime 与 project-root helper
2. 再给 `cli` 增加无头入口
3. 在 `cli` 稳定后移除 `tui` 的 `-T`，避免无头逻辑回流到 TUI 入口
4. 通过单元测试验证 project-root、runtime、headless turn 三层
