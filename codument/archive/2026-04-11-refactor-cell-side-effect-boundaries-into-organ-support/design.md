# 设计：cell 副作用边界收敛到 organ-support

## 1. 目标分层

本 track 将 `cell` 相关能力拆成三类：

- `*-contract`
  - 放数据定义
  - 放副作用接口定义
  - 不放具体环境实现
- `organ-support`
  - 放当前环境下的正式实现
  - 第一轮以本地文件 / 本地目录 / home 配置读取实现为主
  - 后续可扩展为 SQLite / MySQL / 其他 backend
- `*-logic`
  - 放纯逻辑、编排、规则、解析、reducer、hydrate / serialize
  - 通过 contract 依赖副作用
  - 不直接依赖 `fs`、home 配置路径或 session 布局作为正式 backend

## 2. Contract 所有权规则

### 2.1 core-contract

满足以下任一条件的副作用接口进入 `core-contract`：

- `core-logic` 直接依赖
- 与 actor transcript、runtime snapshot、消息历史、编排历史等 core runtime durable state 相关
- 与 model config、skill config 这类 core runtime 需要消费的环境输入相关

### 2.2 organ-contract

满足以下条件的副作用接口进入 `organ-contract`：

- 仅 `organ-logic` 需要
- 与组织层权限、agent config、组织层环境约束等强业务语义有关
- 不应让 `core-logic` 反向依赖

## 3. 第一批拆分方式

### 3.1 可整体迁移到 organ-support 的实现

- 本地消息历史实现
- 本地编排历史实现
- 本地权限配置读写实现
- agent config 目录加载实现
- skill 目录加载实现

这些模块当前几乎都是“读取目录/文件并产出结果”，纯逻辑占比较小，适合作为第一批 support backend。

### 3.2 需要拆分的 mixed modules

- `ActorTranscript.ts`
  - transcript reducer、message 转换等逻辑留在 `core-logic`
  - transcript path / load / write 的环境实现迁到 `organ-support`
- `runtime/snapshot/repository.ts`
  - repository interface 定义进入 `core-contract`
  - 本地文件 repository 实现迁到 `organ-support`
- `RuntimeSnapshots.ts`
  - recovery orchestration、hydrate / serialize 编排保留在 `organ-logic`
  - 文件系统读写与路径处理下沉到 `organ-support`
- `LlmConfigLoader.ts`
  - flatten / merge / fallback 逻辑保留在 `core-logic`
  - home 文件读取边界迁到 `organ-support`
- `SkillRegistry.ts`
  - registry 内存结构保留在 `core-logic`
  - `reloadFromDir` 所依赖的目录扫描能力改为使用 support loader

## 4. Runtime 接线方式

当前 [terminal/packages/organ/src/AIAgent/TerminalRuntime.ts](../../../terminal/packages/organ/src/AIAgent/TerminalRuntime.ts) 直接装配逻辑层本地实现。

重构后应改为：

1. runtime entry 选择并创建 `organ-support` 实现
2. 将这些实现注入 `core-logic` / `organ-logic` 所需 contract
3. 逻辑层只消费 contract，不再自行选择本地文件 backend

这一步是避免“contract 已定义，但默认真相源仍在逻辑层”的关键。

## 5. 本次明确不做

以下内容虽属于更大范围的环境实现问题，但本次不纳入：

- `organ-logic/src/llm/*` 中的 LLM HTTP adapter
- `organ-logic/src/composer/AIAgent/tools/*` 中的本地文件 / 进程工具实现
- `organ-logic/src/mcp/McpSupport.ts` 中的 MCP transport / client
- `symbiont-logic/src/stream/StreamLogger.ts` 等次一级边界问题

这些模块后续应以独立 track 处理，避免本次第一批 layering 改造失控。
