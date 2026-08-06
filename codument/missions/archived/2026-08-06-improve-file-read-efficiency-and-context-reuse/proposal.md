# Mission：improve-file-read-efficiency-and-context-reuse

## 背景和动机

当前 Eidolon 的 `read` 工具在打开大文件时效率很低：模型每次调用只读取约 200 行，而工具实际默认支持 2000 行，且工具 schema 完全没有描述默认值 / offset / limit 语义，模型只能按训练常见的小页面翻页。与此同时，`ContextResourceLoadDecision` 的 already-visible 判定不识别已被 compaction 持久化/压缩的 tool result，配合小步读取会陷入"重读 → 压缩 → 再重读"的循环，进一步放大低效。

压缩阈值（`toolResultBudgetBytes`、`microKeepRecentToolResults` 等）目前是代码内隐式硬编码，没有配置层，用户无法调整。

## 目标

- `read` 工具行为对齐 Claude Code Read 语义：默认 limit 2000、offset 1 起始、大文件截断到 2000 行、header 报 `total_lines`（作为 `<context-resource>` 属性）。
- 提供文件大小/总行数元信息（方向 C：先 size/行数 再决定读取范围），并统一目录/文件默认，消除"同一工具两种隐式默认"。
- `ContextResourceLoadDecision` 识别已压缩/持久化引用为可见覆盖：`delivered_and_compacted` 可见；`pending_first_delivery_compacted` 不可见；already-visible 引用附恢复路径提示；按 range 精确判定。
- 压缩阈值从隐式硬编码迁移为可配置项，交由通用配置机制承载（第三 track 等待用户提供方案，不预设实现）。

## 非目标

- 不把 `read` 改成 Codex `file_view` 的强制 `range` 参数形态（用户明确选择 Claude Code Read 语义）。
- 不引入新的独立配置框架；第三 track 等用户提供通用配置机制后再实施。
- mission 本身不直接改代码；代码、规范、测试落地由真实 track 承担。

## 成功判据

- `read` 对 >2000 行文件截断到 2000 行，header 带 `total-lines`；目录默认与文件默认一致（不再 200 vs 2000 双默认）。
- 模型能先获得文件大小/总行数元信息，再基于文件大小决定读取范围。
- compacted/persisted 引用被判定为可见覆盖，跨 turn 不重复投递同一 range；`pending_first_delivery_compacted` 仍要求读 artifact。
- 相关 tests 覆盖 read 截断、total-lines 元信息、可见性判定与配置化阈值。
- 第三 track 到达 human confirm 即停下，等待用户提供通用配置机制方案。

## 为什么需要 mission 而不是单个 track

该目标横跨 read 工具语义、本地文本资源加载器、可见性判定、compression 管线阈值配置、行为登记表与测试，且第三 track 依赖用户后续提供的通用配置机制。单个 track 容易把"工具行为对齐"与"可见性修复"和"配置参数化"混在一起；mission 负责保持期望态 DAG、事实边界和 track 切片，真实代码落地由三个真实 track 承担。
