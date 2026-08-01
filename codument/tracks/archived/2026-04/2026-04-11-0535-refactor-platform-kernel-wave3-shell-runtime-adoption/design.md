# 设计：Wave 3 的 shell/runtime adoption

## 1. 波次定位

本波次处理 shell/runtime entry 的正式 adoption，不提前做 Wave 4 的物理包迁移。

重点切口：

- `TerminalRuntime`
- `headless`
- `TuiRuntimeCatalog`

其中 `TerminalRuntime` 和 `headless` 在前两波已经基本走到 formal assembly 主路径，本波次真正要收口的是 `TuiRuntimeCatalog` 仍直接读取 `organ-support` 配置加载器的问题。

## 2. 设计原则

### 2.1 shell 只消费 assembly result 与 descriptor

shell 不持有默认 domain config loader，也不自行定义第二份 runtime catalog truth。需要 provider/preset/default model 时，只能向 assembly 要 formal descriptor。

### 2.2 fallback 必须显式

如果 formal descriptor 不存在，允许退化到本地 fallback，但 fallback 必须在代码结构上显式可见，而不是伪装成正式 contract 路径。

### 2.3 不提前做 support 物理拆分

Wave 3 只把消费边界收口。descriptor 背后的实现仍可暂时由 `mod-sys-kernel` 持有并调用当前 support loader；support 的平台/AI 物理拆分放到后续波次。

## 3. 结构方案

### 3.1 runtime catalog descriptor

在 AI runtime assembly result 上增加 `runtimeCatalog` descriptor，至少承载：

- `loadConfigBundle(workDir)`

其中 `ConfigBundle` 返回：

- `providerConfig`
- `presetConfig`

这让 shell 能通过 formal capability 读取 catalog 所需配置，而不是直接 import support loader。

### 3.2 descriptor ownership

- descriptor contract 放在 composer AI contract
- descriptor 默认实现放在 `mod-sys-kernel`
- `TuiRuntimeCatalog` 只消费 descriptor

### 3.3 local-runtime catalog 组装

`TuiRuntimeCatalog` 在 local-runtime 模式下：

1. 装配 `ai-coding` runtime profile
2. 从 assembly result 取 `runtimeCatalog`
3. 用 descriptor 解析 provider/preset/default model
4. 用 assembly `agentConfigs` 建立默认 agent baseline

如果缺 descriptor，则显式走 fallback helper。

## 4. 风险

### 风险 1：只是换个 helper 名字，边界没变

如果 `TuiRuntimeCatalog` 只是从另一个 shell helper 间接调用 support loader，仍然属于第二真相源。

### 风险 2：local-runtime catalog 和主 runtime 装配重新分叉

如果 catalog 默认 agent/config 不是来自 formal assembly result，profile layering 仍可能在 shell 层被绕开。

## 5. 成功标准

Wave 3 达到以下条件时视为完成：

- `TuiRuntimeCatalog` 不再直接 import domain support config loader
- local-runtime config 与默认 agent baseline 来自 formal assembly result / descriptor
- terminal/tui/headless focused tests 继续通过
