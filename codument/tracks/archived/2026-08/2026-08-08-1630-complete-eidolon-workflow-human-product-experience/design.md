# Design

## 上下文

现有系统已经拥有受控 authoring session、canonical proof、Type/Instance/Run facts、Material lifecycle、Ctrl/Data runtime 和恢复能力。缺口位于这些能力之上的产品协调层：低层工具存在，但没有一条业务语言驱动、跨入口一致的 journey。

## 方案概览

1. `WorkflowExperienceCoordinator` 只负责产品决策和阶段计划。
   - 从完整业务请求判定 `direct | ai-ctrl | ai-data | composite`。
   - 选择匹配的业务场景知识，而不是把全部 DSL 文档塞进上下文。
   - 推断当前旅程是创建、编辑、运行已有资源或继续等待。
   - 发布授权与执行授权保持独立。
2. `WorkflowFulfill` 是普通用户主入口。
   - direct 路由返回明确的“不需要 workflow”决定，由当前 Eidolon agent 直接完成业务任务。
   - workflow 路由启动 Eidolon child actor；child 只调用现有 native workflow tools，不拥有文件、flow、fact 或 effect authority。
   - child 按计划完成 context/catalog → author/proof → publish → input/Material inference → Instance → run preview/confirmation → business result。
3. business scenario catalog 是产品知识，不是用户参数。
   - 首批覆盖 research、local digest、fan-out/reduce、routing、adversarial verify、loop-until-dry、generate/filter、tournament、approval process 和 generic composition。
   - 场景只描述业务拓扑、输入事实和完成判据；XNL/depa-flows 细节由内部 authoring context 提供。
4. CLI 与对话共享 tool。
   - TUI/kernel 对普通请求调用 `WorkflowFulfill`。
   - `eidolon workflow agent` 通过 Eidolon headless runtime 调用同一个 tool；`--yes` 是独立执行授权，未授权时停在可复用的已证明/已准备状态。
   - 低层 `create/edit/prepare/run/...` 继续作为专家入口。
5. 输出隔离。
   - 默认输出只含业务目的、业务阶段、结果/等待/确认和可继续动作。
   - 内部 form、node、port、reuse policy、XNL、FQN、Instance/Run ids 和物理路径只在 expert/debug projection 显示。

## 组件与数据流

```text
ordinary business request
  -> WorkflowExperienceCoordinator (route + scenario + journey)
  -> WorkflowFulfill (native tool)
  -> Eidolon child actor
  -> existing authoring/lifecycle/runtime/material tools
  -> business-state projection
```

## 决策摘要

- 高层 journey 是共享 component 能力，不是 CLI 私有 wizard。
- 场景与路由对普通用户透明；专家可以显式覆盖，但覆盖来源会进入 journey evidence。
- direct 路由不强迫创建 workflow。
- 发布和执行是两个独立 gate；`--yes` 只作为明确执行授权使用。
- 详见 `decisions.xnl`。

## 风险 / 权衡

- 纯关键词路由会误判：使用确定性保守路由提供可测试基线，同时把完整上下文交给 Eidolon coordinator actor 作最终语义判断。
- child actor 可能绕过 lifecycle：专用 prompt、工具策略和 journey contract 共同限制，只允许 native workflow tools，并用 tool-call tests 验证。
- 用户输出泄露内部术语：使用独立 business projection contract 和 corpus 负向断言。

## 兼容性设计

- 不改变既有低层工具 schema 和持久化事实。
- 新 tool/CLI 是增量入口；旧 `workflow create/edit/...` 保留为专家接口。

## 待解决问题

- 无阻塞决策；mission 为 `QuestionSeverity=auto`，采用上述保守默认并继续实现。
