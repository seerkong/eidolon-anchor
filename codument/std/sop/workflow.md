# 工作流程总纲（std/sop/workflow.md）

> 原 `std/workflow.md` 移入 std/sop/。这是 codument 行为驱动开发的方法论总纲；各步细节见同目录其它 sop 与 `std/operations/`。

## 核心原则

- **行为驱动**：变更先落 behavior delta（`behavior_deltas/`，见 `std/spec/behavior-delta.md`），归档时提升进行为登记表（`codument/behaviors/`）。
- **编排者轻量**：执行用子代理（独立上下文），编排者只读 `track.xml` 并派发、回写状态；只传路径/引用，子代理自读。
- **独立 spot-check**：子代理的"完成 / 全绿 / 非我责任"自述只是待验证假设；编排者必须用客观命令、行为基线与 diff 审查独立确认后，才能把任务视为完成。
- **三轴分离**：结构（TaskSpace）/ 调度（Schedule）/ 行为（Hooks）正交，见 `std/spec/track-xml-spec.md`。
- **显式 hook 纠偏**：方向/确认/有界修复都由节点或命令生命周期上的 `cdt:` hook 触发；**无显式 hook 不隐式暂停**。
- **知识沉淀与晋升**：track 是迭代轨迹；其中**稳定**的真理要按 [knowledge-tiers.md](@codument/attractors/knowledge-tiers.md) 晋升进 owner 层（`docs/modeling`/`docs/impl`/`behaviors`/`decisions`/`memory`）。owner 文档维护**实时优先**（discuss 期就收敛），归档兜底。这是 codument 相对 track 记忆的弱环，需刻意补强。
- **事实写入磁盘**：长程实现中的实证数据、失败归因、环境约束、机制漏洞和 phase/wave 结论写入 `tracks/<id>/analysis/findings.md`；新会话恢复时先读它。
- **破坏性 git 禁令**：子代理不得使用 `git restore` / `git checkout` / `git stash` 这类会抹掉他人未提交成果的命令；只读 git 查询允许，重命名可用 `git mv`。
- **自包含**：所有提示词/规范在 `codument/`（init 落盘），规则随项目工作区一起维护。

## 三阶段

### 一、创建 track（`codument-track`）
查现状（`codument list [--behaviors]`）→ 选动词开头 kebab `track-id` → 写 `behavior_deltas/<cap>/delta.xml` + `proposal.md`(+`design.md`) + `track.xml`（TaskSpace；phase=第一层 TaskGroup）→ 同轮收集 提交模式 / 校验模式 / 方向审查并写成 Hooks → 等批准。

### 二、实现（`codument-implement` 等）
读 proposal/design/behavior_deltas/analysis/findings → 按 TaskSpace 顺序遍历 phase、层内按 Schedule（默认顺序 / `cdt:child-mode="dag"` 则 DAG，见 `wave-exec.md`）派发子代理 → 独立 spot-check → 回写 status 与 findings → 在 phase/task/track 生命周期跑 `cdt:` hook（`validation.md`）。可按需 `discuss` / `plan-schedule` / `gap-loop` / `verify` / `revise-track`。

### 三、归档（`codument-archive`）
提升 behavior delta 进 `codument/behaviors/` → 移 track 到 `archive/YYYY-MM/...` → 条件提升 decision/memory → 显式 hook 触发 artifact/docs 同步（`archive.md` / `artifact-sync.md`）。

## 何时建 track / 跳过

**建**：新增能力、破坏性变更、架构/模式调整、改变行为的性能/安全工作。
**跳过**：纯 bug 修复、拼写/格式、非破坏依赖更新、纯配置、给既有行为补测试。补充需求落在进行中 track 范围内则并入。

## 外部 CLI 回退

提示词要求运行 `codument validate ...` 但系统找不到 `codument` 命令时，**跳过该外部步骤并明确说明已跳过**，不阻塞工作流。
