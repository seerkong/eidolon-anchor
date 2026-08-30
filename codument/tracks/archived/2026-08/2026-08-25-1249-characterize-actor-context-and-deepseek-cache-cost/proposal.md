# 变更：建立 Actor Context 与 DeepSeek 缓存成本基线

## 背景和动机

已有 DeepSeek 修复能够采集部分 provider cache usage，也修复了部分 Workflow stage prefix mutation，但当前测试主要观察中间 DTO、root prompt 或 tool surface，不能回答最终 serialized request 的完整前缀是否稳定，更不能比较普通 Actor、Workflow lifecycle Actor 与 AI Workflow node Agent 实际支付的控制上下文和工具 schema 成本。

在开始大规模 Actor/capability 重构前，需要建立一个不会修改请求、不会复制 conversation authority、不会泄露 prompt 内容的 final-wire observation contract。它必须把结构前缀、provider 命中事实和 normalized input cost 分开报告。

## “要做”和“不做”

**目标：**

- 从 admitted/serialized provider request 派生 closed cache-relevant units 与 digests。
- 分别计算同 epoch 的 retained-prefix integrity（以前一请求为分母）和 reuse-opportunity coverage（以当前请求为分母），并记录首个差异类型。
- 绑定最终成功 provider usage，分开记录 hit/miss/prompt、tool surface 和 Workflow control token。
- 使用显式注入价格权重计算 normalized cost，不硬编码或联网猜价格。
- 建立普通、Workflow lifecycle、AI Workflow node Agent 三类基线。
- 分开标记官方 DeepSeek 与 SiliconFlow-compatible provider。
- 交付覆盖所有 final-wire writers 的 owner/cache-impact inventory。
- 运行预热后的 3–5 组官方 DeepSeek live baseline；缺少官方凭据时诚实阻断，不以兼容 provider 或 fixture 替代。

**非目标：**

- 本 Track 不移除 Workflow lifecycle 耦合；它只建立可证伪的实际态基线。
- 不把 measurement 写入 Conversation/History。
- 不保存 prompt、tool arguments/results、credentials 或完整 request body。
- 不以稳定但巨大的工具全集换取虚高缓存命中。
- 不把 deterministic fixture 结果称为 live provider cache hit。

## 变更内容

- 新增 provider cache-cost observation contract、normalizer 和纯计算逻辑。
- 在现有 final request observation 与 final-success usage seam 上建立只读投影。
- 新增跨 Actor、同/跨 epoch、retry/recovery/provider switch 测试。
- 生成 Track 内自包含的 baseline evidence，供 Mission G1-T2 批准成本预算。
- 生成完整 writer-to-owner inventory，覆盖 Skill、progress/work-context、epoch、compaction、rewind/recovery、reasoning/tool pairs 与 provider normalization。

## 影响范围

- 受影响能力：`provider-deepseek`
- 受影响代码：provider request admission/observation、DeepSeek usage projection、Workflow/Actor product-shaped tests
- 不改变 canonical Conversation、History、Session、ToolCallDomain 或 runtime-control authority。
