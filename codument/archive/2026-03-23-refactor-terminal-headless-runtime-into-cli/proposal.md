# 变更：将 terminal 无头运行链路从 tui 拆分到 cli

## 背景

当前 `terminal/packages/tui` 同时承担了两类职责：

- 交互式 OpenTUI
- 无头单轮执行（原 `-T` 路径）

这导致：

- `-T` 与交互式 TUI 共用同一个入口文件，职责混杂
- 后续脚本模式、MCP 模式、serve 模式难以在 `terminal/packages/cli` 中自然演进
- 一些本该属于公共 terminal runtime 的逻辑仍滞留在 `tui` 包内

## 变更内容

- 在 `terminal/packages/cli` 中提供无头命令入口，承接原 `-T` 的直接输出链路
- 将无头运行时的公共逻辑按需下沉到 `terminal/packages/organ` 与 `terminal/packages/support`
- 让 `tui` 入口复用公共逻辑，而不是继续内嵌无头执行实现
- 保持 `tui` 交互模式可用

## 非目标

- 本次不实现完整的 serve / MCP server / daemon 模式
- 本次不重写 OpenTUI 页面层逻辑
- 本次不大规模重命名既有 TUI 事件类型与视图组件

## 影响范围

- 受影响代码：
  - `terminal/packages/cli`
  - `terminal/packages/tui`
  - `terminal/packages/organ`
  - `terminal/packages/support`
- 受影响能力：
  - terminal 无头执行
  - TUI 启动入口
  - 运行时初始化与项目根解析
