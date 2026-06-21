## ADDED Requirements

### Requirement: Structured Composer Interactions

系统应当（SHALL）让新的 prototype composer 支持结构化输入交互，而不是仅保留纯文本 textarea。

#### Scenario: Compose slash, mention, file, and image prompt parts

- **GIVEN** 用户在输入区使用 `/`、`@`、文件引用或图片粘贴
- **WHEN** TUI 处理这些输入
- **THEN** 系统生成结构化 prompt part
- **AND** 使用虚拟文本 / extmark 保持输入区中的可视占位

#### Scenario: Preserve prompt history for structured inputs

- **GIVEN** 用户已提交包含结构化 prompt part 的输入
- **WHEN** 用户回看历史输入
- **THEN** 系统保留 prompt history
- **AND** 历史恢复后仍能还原对应的结构化 part

### Requirement: Material State Uses Depa Data Graph

系统应当（SHALL）将当前为了承接素材而保留的临时 state/navigation 桥收敛到 `vendor/depa-data-graph`。

#### Scenario: Materials consume graph projection instead of bridge contexts

- **GIVEN** 消息卡片、system materials、approval 历史和当前选择态都需要共享响应式状态
- **WHEN** TUI 为这些能力建立状态底座
- **THEN** 系统优先通过 `depa-data-graph` projection 提供这些状态
- **AND** 不继续把 `sync-context`、`sync-store`、`route-context` 作为长期状态真相

#### Scenario: Local preferences remain as adapters

- **GIVEN** TUI 仍需要保存 favorite、recent、theme mode 等本地偏好
- **WHEN** 状态层收敛到 graph
- **THEN** 系统仅将“当前选择态”并入 graph
- **AND** 将本地持久化偏好保留为 graph 外围 adapter

### Requirement: File Picker And Frecency

系统应当（SHALL）为 prototype composer 提供文件选择器，并利用 frecency 改善候选排序。

#### Scenario: Rank file candidates using frecency

- **GIVEN** 用户打开文件选择器
- **WHEN** 系统展示候选文件
- **THEN** 系统利用 frecency 对候选项排序
- **AND** 最近且高频使用的文件应优先出现

#### Scenario: File selection feeds structured composer parts

- **GIVEN** 用户在输入区选择某个文件
- **WHEN** 文件被插入到 composer
- **THEN** 系统生成结构化文件 prompt part
- **AND** 输入区保留对应虚拟文本占位
