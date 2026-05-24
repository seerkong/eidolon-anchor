# 设计：import cutover phase1 internal consumers

## 1. 目标

本轮只做最小且高价值的 cutover：

- 让仓内直接旧 support import 归零
- 保留旧包 shim 以保护兼容性
- 用 focused guard 防止旧 import 回流

## 2. 范围判断

当前仓内直接旧包 import 的真实消费者只有 `@cell/organ-support`，且主要位于：

- `cell/packages/organ-logic` 测试
- `terminal/packages/organ` 测试

`mod-sys-kernel` / `mod-sys-coding` 当前没有仓内真实 import 消费方，因此本 phase 不强行制造无效改动。

## 3. 迁移策略

### 3.1 先切内部消费者，再动兼容层

原因：

- 内部消费者最容易验证
- 风险低，收益直接
- 可以先把 shim 的职责收窄到 compatibility-only

### 3.2 兼容 shim 暂不删除

原因：

- 仍需保留对后续 phase 与潜在外部调用方的兼容
- 本轮目标是 cutover import，不是删除兼容机制

### 3.3 用 focused guard 约束回流

不做全仓 grep 门禁，而是在 package migration test 里增加一条针对旧 support import 的精确保护。

## 4. 成功标准

- 仓内普通代码/测试不再直接 import `@cell/organ-support`
- focused tests 通过
- `codument validate --strict` 通过
