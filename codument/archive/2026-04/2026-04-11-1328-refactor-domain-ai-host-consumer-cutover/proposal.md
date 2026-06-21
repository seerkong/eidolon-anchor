# 变更：将 domain-ai 显式宿主推进为默认消费入口

## 背景和动机

`@cell/domain-ai-contract` 与 `@cell/domain-ai-logic` 已经建立，但当前很多实现与调用仍停留在历史 `core-*` / `organ-*` 路径上。

如果不继续做 consumer cutover，这两个包会长期停留在“显式宿主存在，但不是默认真相入口”的状态。

## 要做

- 将 AI-specific contract/logic 的默认消费入口逐步切到 `@cell/domain-ai-contract` / `@cell/domain-ai-logic`
- 优先处理 composer、mod、terminal runtime、tui facade 和 focused tests
- 建立禁止新增历史入口回流的 focused verification

## 不做

- 本次不做大爆炸式全仓 import rename
- 本次不迁移全部底层实现文件物理位置

## 影响范围

- `cell/packages/composer`
- `cell/packages/mod-ai-kernel`
- `terminal/packages/organ`
- `terminal/packages/tui`
- focused tests
