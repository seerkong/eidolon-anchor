# 变更：建立 Workflow Authoring Lifecycle

## 背景和动机 (Context And Why)

当前 Eidolon workflow authoring 只有 depa-flows bundle renderer 和单个 author actor，尚未形成完整的产品生命周期。仅补充面向用户的提示词无法满足可恢复、可验证、可审计的 authoring 要求。

本 track 建立 stage-bound context、template/prebuilt discovery、可恢复四挂载 VFS session、完整编辑审计、proof loop、validation revision、独立 publication gate 和 authoring fact recovery。资源使用标准 XNL，所有写入由 Eidolon native WorkflowComponent 拥有。

## 目标 (Goals)

- 为每项 authoring 能力建立 required behavior → component contract → implementation evidence → acceptance test 的 coverage。
- 建立 definition-stage authoring skill context、自然语言 durable-signal routing 和业务 payload 分离协议。
- 建立 installed template、prebuilt workflow 和 reusable agent resource discovery。
- 建立 `/base`、`/refs`、`/work`、`/out` 四挂载 authoring session、audit 和 session recovery。
- 建立 diff → validate → dry-run → repair、validation revision invalidation 和显式 publication gate。
- 保持 CLI/TUI/对话 tools 共享同一个 WorkflowComponent 与 filesystem/resource authority。

## 非目标 (Non-goals)

- 不建立 XML 业务资源；目标 bundle 从首次写入即为 XNL。
- 不实现 MCP surface。
- 不在本 track 建立 run、Material、Resource Tree 和 execution confirmation lifecycle。
- 不在本 track 增加 direct/ctrl/data/composite 自动产品增强。
- 不调用外部 agent CLI。

## 变更内容 (Changes)

- 扩展 workflow authoring component/service，使其拥有 recoverable session 和 validation/publication state machine。
- 加入可枚举的 authoring context、template 和 prebuilt catalogs，并以安装资源为事实源。
- 把低层 bundle create/patch primitives 纳入统一 authoring lifecycle。
- 将当前 prompt-only WorkflowAuthor 改为消费建立后的 lifecycle，而不是直接生成并发布 bundle。
- 增加覆盖完整 authoring 场景的 acceptance tests。

## 影响 (Impact)

- `ai-organ-logic/src/workflow/authoring`、`tools`、`prompts/skills` 和 component command/query services 会发生结构调整。
- CLI/TUI authoring tests 将从“能写一个 bundle”升级为“能恢复 session 并完成 proof/publication protocol”。
- 旧的直接 publish 路径只保留为受控内部 primitive；高层 authoring 不再绕过 session lifecycle。
