# 工作流程总纲（std/methods/workflow.md）

> 原 `std/workflow.md` 移入 `std/methods/`。这是 codument 行为驱动开发的方法论总纲；各步细节见同目录其它方法文档与 `std/actions/`。

## 核心原则

- **行为驱动**：变更先落 behavior delta（`behavior_deltas/`，见 `std/spec/behavior-delta.md`），归档时提升进行为登记表（`codument/behaviors/`）。
- **编排与执行解耦**：TaskSpace 定义工作，Schedule 定义 readiness，Hooks 定义强制行为；普通叶任务由当前 AI 根据边界、上下文连续性、文件重叠、并行收益与运行时能力自主选择 `local` 或 `delegated`。
- **完成以证据为准**：无论本地执行还是委派，任务都必须回到 acceptance、客观命令、行为基线与 diff 审查后才能完成；委派者的"完成 / 全绿 / 非我责任"自述只是待验证假设。
- **独立性必须显式**：只有 GapLoop、AttractorCheck、独立 verify 或用户显式要求独立审查时，fresh context 才是协议语义；普通实现不因 leaf/DAG 身份被强制委派。
- **三轴分离**：结构（TaskSpace）/ 调度（Schedule）/ 行为（Hooks）正交，见 `std/spec/track-xml-spec.md`。
- **显式 hook 纠偏**：方向/确认/有界修复都由节点或命令生命周期上的 `cdt:` hook 触发；**无显式 hook 不隐式暂停**。
- **知识沉淀与晋升**：track 是迭代轨迹；其中**稳定**的真理要按 [knowledge-tiers.md](@codument/std/attractors/knowledge-tiers.md) 晋升进 owner 层（`codument/modeling`/`codument/engineering`/`behaviors`/`decisions`/`memory`）。owner 文档维护**实时优先**（discuss 期就收敛），归档兜底。这是 codument 相对 track 记忆的弱环，需刻意补强。
- **事实写入磁盘**：长程实现中的实证数据、失败归因、环境约束、机制漏洞和 phase/wave 结论写入 `tracks/active/<id>/analysis/findings.md`；新会话恢复时先读它。
- **破坏性 git 禁令**：执行代理不得使用 `git restore` / `git checkout` / `git stash` 这类会抹掉他人未提交成果的命令；只读 git 查询允许，重命名可用 `git mv`。
- **自包含**：所有提示词/规范在 `codument/`（init 落盘），规则随项目工作区一起维护。

## 三阶段

### 一、创建 track（`codument-plan-track`）
查现状（`codument list [--behaviors]`）→ 选动词开头 kebab `track-id` → 写 `behavior_deltas/<cap>/delta.xml` + `proposal.md`(+`design.md`) + `track.xml`（TaskSpace；phase=第一层 TaskGroup）→ 同轮收集 提交模式 / 校验模式 / 方向审查并写成 Hooks → 等批准。

### 二、实现（`codument-impl-track` 等）
读 proposal/design/behavior_deltas/analysis/findings → 按 TaskSpace 遍历 phase、按 Schedule 计算 ready 节点 → AI 对普通叶任务自主选择本地执行或委派 → 以 acceptance/测试/diff 做完成验证 → 由 track executor 唯一回写 status 与 findings → 在生命周期跑显式 `cdt:` hook。可按需 `discuss` / `maintain-track` / `gap-loop` / `verify`。

### 三、归档（`codument-archive-track`）
提升 behavior delta 进 `codument/behaviors/` → 移 track 到 `tracks/archived/YYYY-MM/...` → 条件提升 decision/memory → 显式 hook 触发 artifact/docs 同步（`archive-track.md` / `artifact-sync.md`）。

## 何时建 track / 跳过

**建**：新增能力、破坏性变更、架构/模式调整、改变行为的性能/安全工作。
**跳过**：纯 bug 修复、拼写/格式、非破坏依赖更新、纯配置、给既有行为补测试。补充需求落在进行中 track 范围内则并入。

## 外部 CLI 回退

提示词要求运行 `codument validate ...` 但系统找不到 `codument` 命令时，**跳过该外部步骤并明确说明已跳过**，不阻塞工作流。
