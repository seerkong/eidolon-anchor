# 变更：平台微内核后续 sub-wave 的 import cutover phase1

## 背景和动机

前一个 sub-wave 已经完成 support/mod 的物理宿主迁移，并保留：

- `@cell/organ-support`
- `@cell/mod-sys-kernel`
- `@cell/mod-sys-coding`

作为兼容 shim。当前仓内仍有少量内部消费者直接 import 旧 support 包名，这会让 shim 长期停留在“内部真实依赖”而不是“兼容过渡层”的状态。

## 要做

- 创建 import cutover phase1 track
- 将仓内内部消费者从 `@cell/organ-support` 切到 `@cell/domain-ai-support`
- 增加 focused guard，防止旧 support import 回流到普通源码/测试

## 不做

- 本次不删除兼容 shim 包
- 本次不移除旧 tsconfig path alias
- 本次不处理仓外调用方或未来发布兼容策略

## 变更内容

- 完成 internal consumers 的第一批 import cutover
- 将 `@cell/organ-support` 收敛为 compatibility-only package
- 为下一批 `mod-sys-*` cutover 保留结构空间

## 影响范围

- 受影响代码：
  - `cell/packages/organ-logic/**/*`
  - `terminal/packages/organ/**/*`
  - `codument/tracks/refactor-platform-kernel-subwave-import-cutover-phase1-internal-consumers/*`
- 与现有 track 关系：
  - 承接 `refactor-platform-kernel-subwave-support-and-mod-physical-rename`
  - 继续推进“新宿主为唯一 truth host，旧包只做兼容层”
