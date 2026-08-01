# 变更：实施平台微内核 Wave 7 的 platform kernel baseline and support seeding

## 背景和动机

当前仓库已有 `platform-only` profile，但它仍是空 profile；`platform-support` 也仍是空宿主包。

这意味着平台层只存在形式上的 contract / profile 外壳，而没有真正的可复用平台 baseline。

## 要做

- 建立第一批真实 platform kernel baseline
- 让 `platform-only` 不再只是空 profile
- 将第一批跨领域 support 实现上收到 `platform-support`

## 不做

- 本次不追求把所有 support 都重新归位
- 本次不直接处理 AI slash contract
- 本次不做 shell bridge 全面去 AI 化

## 影响范围

- `cell/packages/platform-support`
- 新的 `mod-platform-kernel` 或等价宿主
- `cell/packages/mod-profiles`
- focused tests
