## 上下文
当前 runtime work context 用多枚举组合表达任务类型、任务阶段、工具偏好和执行策略。新的设计将控制面收敛为两个小枚举，并把状态切换来源显式化：work mode 只由用户手动切换，task phase 只由模型内部 tool call 切换。

## 方案概览
1. Work mode 数据模型
   - `type WorkMode = "build" | "plan"`。
   - 默认值为 `build`。
   - `/work-mode build` 和 `/work-mode plan` 是唯一正式切换入口。
   - Slash command 被 runtime 消费，不写入语义 conversation history，不触发 provider 请求。

2. Task phase 数据模型
   - `type TaskPhase = "normal" | "answer"`。
   - 默认值为 `normal`。
   - 模型通过内部 tool call 切换，例如 `SetTaskPhase({ phase: "answer", reason })`。
   - 新 human input 到来时 task phase 回到 `normal`，除非模型再次调用工具切换。

3. 权限和工具策略
   - `workMode=plan` 是硬权限边界，禁止或要求确认写文件、patch、edit、破坏性 bash。
   - `workMode=build` 使用常规工具权限。
   - `taskPhase=answer` 是响应形态，不是权限边界；如果 answer 后继续调用普通工具，runtime 可自动回到 `normal`。

4. Prompt 和缓存
   - Prompt overlay 使用极简字段：`work_mode` 和 `task_phase`。
   - Overlay 保持 late insertion，不进入 stable provider prefix。
   - DeepSeek stable prefix hash 继续只覆盖 system/tools 等稳定部分。

5. 删除旧自动推断
   - 删除文本分类推断旧 work modes 的逻辑。
   - 删除 `verification` 等旧 task phase 推断。
   - 删除与 work mode/task phase 相关的调用次数、连续工具次数、轮次启发式切换。
   - 保留必要的 tool permission 分类，但它只用于权限判断，不用于自动切换 work mode。

## 影响范围与修改点（Impact）
- `cell/packages/ai-core-contract/src/runtime/ContextControl.ts`：收敛类型定义。
- `cell/packages/ai-organ-logic/src/runtime/ContextControlPlane.ts`：移除自动推断，改为手动 work mode 和 tool-call task phase。
- `cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts`：接入 task phase tool 和 work mode permission policy。
- `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`：接入 `/work-mode` slash command。
- TUI/CLI/headless tests：覆盖 slash command、permission gating、task phase tool call、DeepSeek cache stability。

## 决策摘要
- 详见 `decisions.md`。
- 当前关键结论：work mode 手动，默认 build；task phase 由模型工具调用切换；旧自动推断和调用次数逻辑删除。

## 风险 / 权衡
- 风险：删除自动推断后，用户需要显式使用 `/work-mode plan` 才能进入只读模式。
  - 缓解：TUI 清晰显示当前 work mode，并让默认 build 符合 coding agent 的常规执行期望。
- 风险：模型可能忘记调用 task phase tool。
  - 缓解：工具描述保持短而明确，并在 prompt overlay 中说明 answer phase 的用途。
- 风险：旧 session 中的旧 work mode/task phase 无法一一映射。
  - 缓解：迁移时统一归一化为 `build/normal`，不把旧自动推断状态当作用户手动选择。

## 兼容性设计
- 旧枚举值在 session recovery 或 upgrade 中归一化为 `workMode=build`、`taskPhase=normal`。
- 不保留旧枚举兼容 API 或 shim。
- 如检测到旧值，只作为 migration 输入处理，不在运行时继续传播。

## 迁移计划
1. 添加 failing tests 覆盖新枚举、slash command、task phase tool、旧值归一化。
2. 收敛 contract 类型。
3. 改造 context control plane 和 prompt overlay。
4. 接入 `/work-mode` runtime command。
5. 接入 task phase internal tool。
6. 删除旧自动推断和次数逻辑。
7. 更新 tests 并构建 TUI 产物。

## 待解决问题
- 内部 task phase tool 的最终工具名可在实现时按现有 tool 命名规范确定。
- `plan` 模式下破坏性 bash 是硬阻断还是 permission prompt，实施时需结合现有权限系统选择最小侵入方案。
