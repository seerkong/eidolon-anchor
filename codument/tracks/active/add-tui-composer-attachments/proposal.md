# 变更：为 TUI Composer 增加附件与多模态输入

## 背景和动机 (Context And Why)

TUI Composer 已能显示文件 part、通过 Ctrl+O 选择文件，并能从剪贴板创建图片 data URL，但拖入文件没有稳定入口，附件块删除不是显式原子操作，parts 计数可能在 extmark 与 store 不一致时滞后。更关键的是，TUI runtime 当前只提取 text part，附件在进入 actor 和 provider 前被静默丢弃。

本变更把附件从界面能力补齐为端到端能力：在终端中接收拖入路径，统一附件块生命周期，使用配置声明的模型 modalities 做发送门控，并在支持视觉的 OpenAI 类 adapter 中投影图片输入。

## “要做”和“不做” (Goals / Non-Goals)

**目标:**

- 将终端拖入文件产生的路径粘贴识别为一个或多个附件，并复用当前文件 part/extmark 表示。
- 让 Backspace/Delete 命中附件块边界时一次删除整个块，并立即、准确更新右下角 parts 数量。
- 让 structured prompt parts 经 TUI client、terminal bridge、actor mailbox、conversation materialization 一直保留到 provider adapter。
- 解析并传播 `modalities.input/output`，仅为显式声明 image input 的模型发送图片。
- 为 OpenAI Chat Completions 与 Responses 生成各自合法的图片 content part，并对不支持的模型在请求前 fail closed。
- 更新 deepseek adapter 的 V4 Flash 模型识别与示例配置；依据当前官方文档将 `deepseek-v4-flash` 保持为 text-only。

**非目标:**

- 不把 OpenTUI 的鼠标坐标 drop 事件误当作 OS 文件传输协议。
- 不在本 track 中实现 PDF、音频或视频的 provider 原生输入。
- 不把任意二进制文件自动内联进 prompt；普通文件保持本地文件引用语义。
- 不猜测尚未发布的 DeepSeek 图片请求格式，也不把 placeholder 响应视为识图成功。
- 不修改与本功能无关的 ContextCompressor 用户工作树改动。

## 变更内容（What Changes）

- 增加路径粘贴解析、文件 MIME/大小校验、批量附件插入与错误反馈。
- 把附件的 extmark 与 structured part 作为单一原子块管理，统一插入、移动、删除、计数和恢复。
- 引入 provider-neutral 的 canonical input content parts，并扩展 human input/runtime message contract。
- 让 provider config schema、模型 catalog 和 runtime capabilities 保留 `modalities`。
- 为 OpenAI-compatible Chat Completions/Responses 增加 image projection 与 capability gate。
- 更新 DeepSeek V4 Flash 文本能力、限制和官方兼容性测试；图片输入明确拒绝。
- 增加 Windows/macOS/Linux 路径、多个附件、原子删除、历史恢复、视觉请求体和 text-only 拒绝的测试。

## 影响范围（Impact）

- 受影响的能力（behaviors）：`terminal-tui-shell`、`llm-multimodal-input`、`provider-deepseek`
- 受影响的代码：TUI Composer 与 runtime client、terminal runtime bridge、AI actor/conversation/LLM DTO、provider config/catalog、OpenAI Chat/Responses adapters、DeepSeek driver/capabilities、示例配置与相关测试。
