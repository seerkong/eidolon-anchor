# 变更：迁移 ExecProtocolGraph 到 Unified DataGraph

## 背景和动机 (Context And Why)

ExecProtocolGraph 仍直接导入 1.0.1 已删除的 reducer projection API，令
terminal organ 的 focused protocol test 在加载前失败。

## 目标

- 用 DataGraph source 和 stream-driven state signal 替换旧 projection。
- 保留 terminal snapshot、listener、completion、pause 和 dispose 语义。

## 非目标

- 不修改 terminal observability 或 TUI Solid consumer。
- 不改变 reducer 的业务规则。
