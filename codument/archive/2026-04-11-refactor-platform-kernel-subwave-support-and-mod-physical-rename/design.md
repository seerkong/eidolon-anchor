# 设计：support 与 mod 的物理 rename sub-wave

## 1. 波次定位

这个 sub-wave 承接前四波之后的结构迁移，不属于前四波的“漏做”，而是下一轮正式工作。

目标不是立即 rename 全仓，而是：

1. 先冻结 support split 方案
2. 再冻结 mod rename 方案
3. 最后规划增量 cutover

## 2. 目标结构

### 2.1 support

- `platform-support`
  - profile/bootstrap config loader 中纯平台部分
  - generic shell resource locator
  - generic event log storage adapter
  - 其他不依赖 AI identity/state/tooling/provider 的环境实现

- `domain-ai-support`
  - agent/skill/provider config loader
  - AI runtime snapshot/transcript/history
  - permission config
  - workspace AI assets
  - 其他直接依赖 AI runtime 语义的环境实现

### 2.2 mods

- `mod-ai-kernel`
  - 当前 `mod-sys-kernel` 的物理归位目标
- `mod-ai-coding`
  - 当前 `mod-sys-coding` 的物理归位目标

## 3. 迁移策略

### 3.1 support split 优先于 mod rename

原因：

- support 的 ownership 更复杂
- 一旦 support 切分不清，mod rename 只是换名字，不解决结构问题

### 3.2 保留兼容入口，但不新增第二真相源

可短期保留旧包 re-export / redirect，但：

- 旧包不能重新定义自己的 truth
- 新旧包必须以新路径为唯一实现宿主

### 3.3 验证优先级

- ownership tests
- runtime adoption tests
- package migration smoke tests

## 4. 风险

### 风险 1：把 AI config/history/snapshot 误归到 platform-support

这样会再次污染平台边界。

### 风险 2：只做 rename，不做 ownership split

这样只是换名字，不解决结构问题。

### 风险 3：一次性全仓 rename

这会破坏前四波已经建立的连续运行保障。

## 5. 成功标准

达到以下条件时，这个 sub-wave 才应进入实际实现：

- support split table 明确
- mod rename map 明确
- 增量 cutover 顺序明确
- 每一步的 focused verification baseline 明确
