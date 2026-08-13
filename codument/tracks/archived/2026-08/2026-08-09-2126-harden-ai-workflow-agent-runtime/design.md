## 上下文

该 track 处理 workflow product 依赖的通用 actor/provider/tool-stream 可靠性。它不拥有自然语言语义，但必须保证专属 workflow actor 的每次结构化动作和最终结果可以被父 actor可靠观测。

## 方案概览

1. 统一 terminal semantics
   - provider failure 产生 fail terminal，不进入 delegate complete 分支。
   - child-done 保留结构化 error code、retry evidence 和可见 business error projection。
2. 统一 result authority
   - orchestrator-managed 和 immediate-driver 两条分支都从 Conversation Domain materialize history。
   - high-level workflow tool 只接受 result、wait、proof 或 failure 四类结构化完成结果。
3. 修复 tool-call reconstruction
   - 以 provider tool-call identity/index 维护独立 accumulator。
   - 缺少可判定 identity 时使用显式 adapter normalization 或 protocol failure，禁止默认 index 0 静默合并。
4. 建立 product progress budget
   - 每个 workflow stage 记录进展事实，如 workspace revision、validation、dry-run、wait 或 result。
   - stage result 使用显式 union：`workspace_changed | proof | published | prepared | running | waiting | completed | failed`；空文本不是结果。
   - 每个 actor turn 必须产生上述 outcome 或一个 native tool effect；连续无进展达到预算即终止并报告 diagnostics。
   - validation/correction/proof-repair 是有界 loop，达到轮数或 stage deadline 后保留 workspace 与 diagnostics 返回，不继续开放式探索。
   - provider retry deadline 受上层 interactive stage deadline 约束。
5. 统一 VFS surface
   - 四个 mount 始终可描述；空 mount 返回空集合。
   - directory/file operation 不匹配返回结构化诊断。

## 影响范围与修改点（Impact）

- AI agent execution/orchestrator/conversation projection。
- provider effect bundle 与 Chat Completions stream reducer。
- workflow high-level tool result contract。
- workflow authoring session store/workspace tools。

## 决策摘要

- 详见 `decisions.xnl`。
- 错误不能降级为空成功。
- Conversation Domain 是 child result 的唯一事实源。
- tool-call identity 不明确时 fail closed。
- KWF 的有限阶段旅程作为 latency 结构证据；具体 deadline/repair budget 由 Eidolon 产品配置拥有。

## 风险 / 权衡

- 更严格的 protocol failure 可能暴露第三方 provider 不兼容 → 用 provider contract smoke 和清晰 diagnostics 代替静默损坏。
- 较短 stage deadline 可能误杀慢模型 → deadline 可配置，但 interactive product 必须有硬上界和进展感知。
- shared runtime 修改影响非-workflow delegate → 通过通用 lifecycle regression tests 验证兼容。

## 兼容性设计

- 成功 child 的文本 projection 保持兼容；新增结构化 failure 不再伪装成成功文本。
- provider adapter 可提供兼容 normalization，但 shared reducer 不猜测业务意图。

## 迁移计划

1. 先增加事故级失败和并行 tool-call 回归测试。
2. 修正 terminal/result authority。
3. 修正 stream identity。
4. 增加 progress/deadline 和 VFS 诊断。
5. 运行通用 delegate tests 与真实 workflow incident E2E。

## 已关闭的研究问题

- KWF 未定义可复用的 actor stage deadline；其可复用原则是结构化非空输出、确定性 proof、显式阶段和有界失败。Eidolon 在此基础上定义自己的 stage outcome/deadline，而不把任意 provider timeout 当产品预算。
