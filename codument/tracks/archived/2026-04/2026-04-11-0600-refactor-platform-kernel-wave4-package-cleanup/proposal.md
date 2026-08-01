# 变更：实施平台微内核 Wave 4 的 package cleanup

## 背景和动机

Wave 1 到 Wave 3 已分别完成 contract/composer 收口、profile layering、shell/runtime adoption。当前仍残留一组旧 runtime profile 兼容路径：

- `defaultCodingRuntimeProfile`
- `assembleDefaultCodingRuntimeProfile`

这些别名已经不再承担正式语义，只是历史兼容层。如果继续保留，会让 “正式 profile 命名” 与 “旧默认命名” 并存，延长第二套 surface 的寿命。

本 track 承接微内核迁移路线中的 **Wave 4**，目标是在不打断 terminal/tui/headless 主路径的前提下，完成最小必要的旧路径清理。

## 要做

- 移除 `default-coding` 兼容 profile 导出
- 将剩余调用方与测试全部切到正式的 `ai-coding` 命名
- 同步 focused tests，锁定正式命名不再回流

## 不做

- 本次不做大规模 workspace 包 rename
- 本次不重命名 `@cell/mod-profiles` 包名
- 本次不处理 support 包的物理迁移
- 本次不改变 terminal/tui/headless 的正式运行入口

## 变更内容

- 删除 `defaultCodingRuntimeProfile` 与 `assembleDefaultCodingRuntimeProfile`
- 更新 runtime/profile focused tests 到正式 profile naming
- 保持当前 `ai-coding` 主路径与验证基线不变

## 影响范围

- 受影响代码：
  - `cell/packages/mod-profiles`
  - runtime/profile focused tests
- 后续影响：
  - 当前四波实施路线完成，可进入归档或下一轮更大尺度结构演进
