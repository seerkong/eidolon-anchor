# 变更：独立验证 Definition/Instance/Run 与 targeted Agent 复用 E2E

## 背景和动机 (Context And Why)

Definition→Instance→Run、typed Agent facade 和 targeted Skills 已分别实现。最终验收必须把这些事实串成一个可恢复的产品链：完整 ResourcePackage 被证明和发布，Ctrl/Data 都从冻结 instance 运行，首节点创建具名 Agent instance，后续不同 invocation key 按 name 与返回 id 复用同一个 generic actor/session；live source 删除和新 VM 后仍成立。

## 目标 / 非目标

**目标:**

- 独立运行物理 ResourcePackage Ctrl/Data E2E，核对 schema/policy/material/task proof、typed output、instance/run checkpoint 与 generic runtime evidence。
- 验证 by-name、by-id、snapshot save/hydrate、pending/completed repetition都不创建第二 actor/session。
- 验证已安装 binary 与 global four-Skill closure 为当前受审产物。
- 形成 issues-first fresh verify 报告。

**非目标:**

- 不新增 provider、workflow store、selector router、runtime API 或 npm package。
- 不要求复用 workflow child conversation history。
- 不进入 StepSpace/state-sidecar 性能优化。

## 影响范围

- 行为：`eidolon-ai-workflow-native-capability`
- 验证：workflow physical E2E、generic snapshot、publication proof、compiled binary/global Skill readback
- 产物：本 track reports/verification receipts 与 final verify report
