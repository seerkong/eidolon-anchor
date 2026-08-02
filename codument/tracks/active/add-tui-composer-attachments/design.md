# Design

## 上下文

附件当前在 Composer 层已经有结构化雏形，但提交路径把它压成纯文本。设计需要同时解决终端输入限制、UI 块一致性、canonical conversation 数据形状、provider-specific wire projection 和模型能力门控。所有行为以配置 `modalities` 为真源，避免按模型名称猜测视觉能力。

## 方案概览

1. 统一 Composer 附件入口与块生命周期
   - 使用 OpenTUI paste event 取得 bracketed-paste bytes；解析单一路径、Windows 引号路径、shell escaped 路径、多行/多路径和 `file://` URI。
   - 只有全部 token 都能解析为存在的本地文件时才把该 paste 解释为拖入附件；否则保持普通文本粘贴，避免误吞用户文字。
   - 把 Ctrl+O、路径粘贴和剪贴板图片统一调用 `insertAttachmentParts()`。Composer 只做纯 tokenizer/normalizer 与 part/extmark 编辑，不直接执行 stat/read/MIME sniff。
   - 引入注入式 `AttachmentResolverPort`：contract 位于 terminal contract/runtime 边界，terminal support 实现路径 allow/存在性、stat/read、MIME sniff、大小限制、内容 snapshot/data URL 编码。测试使用 mock resolver，不让 UI 逻辑绑定文件系统。
   - 为 extmark 增加按 cursor/range 命中附件块的删除 helper。Backspace 命中块尾、Delete 命中块首或 selection 覆盖块时，先 prevent default，再一次删除完整虚拟范围、extmark 和 part。
   - parts 计数从经过 reconciliation 的 canonical composer parts 派生；插入/删除/恢复在同一 store transaction 后同步 state graph。
2. 建立 provider-neutral structured input contract
   - 定义 ingress `InputContentPart`：`text`、`image`、`file_reference`。`file_reference` 只存在于 local ingress，包含路径与显示名，不是 provider-visible content。
   - 在进入 actor Conversation 前由 `AttachmentResolverPort` 解析 snapshot：受支持图片成为 canonical image；受支持文本文件成为带 basename、source digest 和内容的 canonical text material；不可读、超限或不支持的二进制文件 fail closed。绝对路径不写入 provider message、request observation 或日志。
   - TUI runtime client 保存提交的 runtime parts，并把 canonical parts传给 `TuiRuntimeBridge.turn()`；slash command 只使用 text projection 做命令识别，普通 AI turn 不丢附件。
   - 将 actor `humanInput` mailbox 从 string 升级为显式 structured payload，同时提供 text-only construction/helper，降低 headless/legacy caller 迁移风险。
   - Conversation 与 `ChatMessage.content` 接受 string 或 canonical content array；统一 helper 负责文本投影、token estimation、compression 与日志摘要，避免各消费者自行 `String(content)`。
3. 传播模型 modalities 并在 I/O 前门控
   - 扩展 provider raw/normalized config、JSON schema、flattened model config 与 `LlmModelCapabilities`，保留 `modalities.input/output`。
   - TUI catalog 从真实配置生成 attachment/image flags，删除“所有模型都支持 image/pdf”的硬编码。
   - 请求 planner 在任何 provider request observation/网络 I/O 前比较输入 part 与模型 modalities。图片遇到 text-only 模型时返回稳定错误，保留 Composer 内容供用户切换模型或删除附件后重试。
   - 拒绝时发布脱敏的 `unsupported_modality` semantic diagnostic：model ref、声明 modalities、part kind、MIME、size 与内容 digest；不得包含 data URL、base64、文件正文或绝对路径。该事件与零 provider call 一起构成 send-before 证据。
4. 在 adapter 边界生成图片 wire shape
   - OpenAI-compatible Chat Completions：user content 投影为 `[{type:"text",text}, {type:"image_url",image_url:{url}}]`；assistant/tool/system 保持各自现有约束。
   - OpenAI Responses：user message content 投影为 `input_text`/`input_image`，并让 full replay、incremental replay 与 continuation digest 使用同一 canonical projection。
   - 仅允许受支持的 image MIME/data URL，限制单文件/总请求大小，并确保日志、request observation、错误信息不输出完整 base64。
5. DeepSeek V4 Flash 接入边界
   - deepseek adapter 识别 `deepseek-v4-flash`，沿用 `https://api.deepseek.com/chat/completions` 的 OpenAI-compatible Chat 请求；同步 1M context、384K max output、thinking/reasoning effort 与工具/流式能力的配置和测试。
   - `examples/config/llm-provider.json` 为 DeepSeek V4 Flash 显式设置 `modalities.input: ["text"]`，而 GPT 视觉示例继续使用 `["text", "image"]`。
   - 当前 DeepSeek Chat/Responses/Anthropic 兼容接口均不接收图片，因此 capability gate 必须拒绝图片。未来官方开放后，只在取得正式请求 schema 与限制证据后更新 modalities 和 adapter projection；canonical/TUI 链路无需重做。

## 影响范围与修改点（Impact）

- TUI：`features/composer/{composer,model/*}`、文件选择/剪贴板支持和 Composer tests。
- Terminal：`TuiRuntimeClient`、`TuiRuntimeBridge`、注入式 `AttachmentResolverPort`/terminal-support effect 及 runtime projection/session tests。
- Cell contracts：actor mailbox、LLM message/content 与 provider config/capability types。
- Cell logic/support：conversation materialization/compression、OpenAI Chat/Responses input builders、DeepSeek driver/capability resolution。
- 配置与文档：`examples/config/llm-provider.json` 及配置 schema tests。

## 决策摘要

- 终端“拖入文件”采用路径粘贴识别，因现有终端/OpenTUI 没有 OS file payload。
- attachment block 以 extmark + structured part 为一个原子单元。
- canonical content 与 provider wire shape 分离，provider adapter 是唯一投影边界。
- file_reference 是 local-only；terminal support resolver 负责转成脱敏、可持久化的 text/image snapshot，provider 永不收到绝对路径。
- unsupported modality 通过结构化、脱敏 semantic diagnostic 观测，并证明 provider I/O 为零。
- 模型图片能力只由配置 modalities 决定，不由 provider 名称或 TUI 默认值猜测。
- text-only 模型在发送前拒绝图片并保留草稿，不静默降级。
- DeepSeek V4 Flash 当前保持 text-only；官方未提供可用的识图 API contract。
- 过程决策见 `decisions.xnl`。

## 风险 / 权衡

- 路径文本与普通文本存在歧义 → 仅在完整 paste 可解析为存在文件集合时转附件，否则原样粘贴。
- Windows 路径引用规则复杂 → 用平台无关 tokenizer 加 Windows drive/UNC、双引号、PowerShell/shell escape 和 `file://` fixture 覆盖。
- 文件读取副作用若落入 UI 会破坏可测试性与 runtime owner → 用 contract + injected terminal-support resolver 分离纯解析和 I/O。
- base64 放大会话与请求 → 限制 MIME/大小、在插入时早失败，并禁止日志记录 payload。
- 扩展 `ChatMessage.content` 会影响许多文本消费者 → 提供集中式 text projection helper，并用编译与 contract tests 逐一迁移。
- provider continuation replay 可能丢图片或重复图片 → Chat/Responses full/incremental builders共享 canonical projector，并加入多轮 replay tests。
- DeepSeek 产品宣传与 API 文档可能快速变化 → 将官方兼容性作为版本化测试依据，配置显式 text-only，后续证据驱动更新。

## 兼容性设计

- 纯文本 caller 仍可传 string；normalizer 在 runtime boundary 转为单个 text part。
- 旧 session 的 string `ChatMessage.content` 保持可读；新结构化内容使用联合类型并在恢复时验证。
- Ctrl+O、Ctrl+V 图片与普通文本粘贴保持原交互；路径识别失败时不改变文本。
- text-only provider 的纯文本请求体不变。
- 旧 file part 在恢复后仍是 local reference；发送前重新经 resolver 验证并生成 snapshot。已持久化的新 canonical snapshot 不依赖原绝对路径重放。

## 迁移计划

1. 以失败测试锁定路径粘贴、附件块原子删除与计数一致性。
2. 引入 canonical content contract，迁移 TUI→actor→conversation 链路并验证 persistence/recovery。
3. 传播 modalities，先实现 I/O 前 fail-closed gate。
4. 增加 OpenAI Chat/Responses image projection、大小限制、日志脱敏和 replay tests。
5. 更新 DeepSeek V4 Flash 配置/能力并验证图片拒绝与文本/工具/流式回归。
6. 运行 TUI、runtime、conversation、provider 定向测试与相关 package typecheck；在 Windows 实际终端做路径拖入 smoke test。

## 待解决问题

- 提交模式与 phase 校验 hook 由用户审查计划时选择。
- DeepSeek 视觉能力只有在官方 API 文档发布可验证的 image request contract 后才进入后续 track 或本 track 的明确修订。
