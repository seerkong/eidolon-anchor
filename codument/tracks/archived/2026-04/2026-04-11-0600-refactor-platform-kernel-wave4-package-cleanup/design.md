# 设计：Wave 4 的 package cleanup

## 1. 波次定位

本波次执行“最小必要的旧路径清理”，而不是做高风险的大规模包 rename。

优先收口点：

- 删除 `defaultCodingRuntimeProfile`
- 删除 `assembleDefaultCodingRuntimeProfile`

## 2. 设计原则

### 2.1 正式命名唯一化

Wave 2 已经建立正式三层 profile，Wave 4 应让对外 surface 只剩正式命名，避免历史兼容层继续被新代码引用。

### 2.2 行为不变、命名收口

本波不改变组合顺序或运行时行为，只移除旧命名并更新剩余引用。

### 2.3 保守清理

当前不做 `@cell/mod-profiles` 的包 rename，也不做 `organ-support` 的物理拆分。先收口最小旧 surface，保持风险最低。

## 3. 结构方案

- `@cell/mod-profiles` 只导出：
  - `platformOnlyRuntimeProfile`
  - `aiKernelRuntimeProfile`
  - `aiCodingRuntimeProfile`
  - `assemblePlatformOnlyRuntimeProfile`
  - `assembleAiKernelRuntimeProfile`
  - `assembleAiCodingRuntimeProfile`
- focused tests 改为只验证正式命名与正式 profile id

## 4. 风险

### 风险 1：测试仍保留旧命名，导致新代码继续引用

如果测试继续使用旧 alias，等于继续把历史 surface 作为“可接受路径”保留下来。

### 风险 2：清理时误伤主路径

如果删除 alias 的同时漏改测试或入口，会造成主路径回归。本波通过 focused tests 与 smoke tests 控制风险。

## 5. 成功标准

Wave 4 达到以下条件时视为完成：

- `default-coding` 兼容 profile alias 完全移除
- 代码与测试全部切到正式 profile naming
- terminal/tui/headless 主路径继续通过
