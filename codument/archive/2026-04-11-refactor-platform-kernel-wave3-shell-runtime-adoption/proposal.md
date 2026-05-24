# 变更：实施平台微内核 Wave 3 的 shell/runtime adoption

## 背景和动机

Wave 1 已完成 contract/composer/ownership 收口，Wave 2 已完成正式 profile layering。下一步需要把 shell/runtime entry 的消费边界真正切到 assembly result 与 capability descriptors，否则 `TerminalRuntime`、`TuiRuntimeCatalog` 这类入口仍可能偷偷保留一份默认语义或配置真相源，破坏微内核分层。

本 track 承接微内核迁移路线中的 **Wave 3**，目标是在不打断 terminal/tui/headless 主路径的前提下，让 shell 层只消费：

- 正式 runtime assembly result
- assembly 暴露的 capability ports / descriptors

## 要做

- 为 shell 层补一个正式 runtime catalog/config descriptor
- 让 `TuiRuntimeCatalog` 不再直接 import domain support 配置加载器
- 锁定 terminal/tui/headless 的 shell adoption 行为
- 补 focused tests，验证 local-runtime facade 不再依赖 hidden local config truth

## 不做

- 本次不做 support 的平台/AI 物理拆分
- 本次不清理所有旧路径或执行物理包 rename
- 本次不处理 Wave 4 的 package cleanup
- 本次不把所有非主 runtime 调用方一次性改成同一抽象层

## 变更内容

- 在 runtime assembly 上增加正式的 catalog/config descriptor
- 让 `TuiRuntimeCatalog` 通过 assembly descriptor 读取 provider/preset 信息
- 让 local-runtime catalog 的 agent/config 默认值来自正式 assembly，而非 module-local static truth
- 通过 runtime adoption focused tests 保护 shell 边界

## 影响范围

- 受影响代码：
  - `cell/packages/composer`
  - `cell/packages/mod-sys-kernel`
  - `terminal/packages/tui`
  - 相关 runtime adoption tests
- 后续波次依赖：
  - Wave 4 package cleanup
