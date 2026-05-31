# eidolon-anchor 项目级 Attractor

*初始化时间: 2026-03-22T14:38:44.725Z*  
*最后更新: 2026-06-02*

---

## 什么是 Attractor

Attractor（吸引子）是系统无论如何变化，都会持续向着其靠拢的方向性力量。不是从 A 到 B 的路径规范，而是在目标和路径周围，持续吸引和引导如何走的力量。

---

## 核心 Attractor

### DEPA 范式 [depa-paradigm]

**核心描述：** DEPA = Data-Effect-Processor-Actor，是本项目底层库的命名约定，代表整个架构的底层思想范式。

**具体体现：**
- **Data（数据）**：数据是一等公民，代码围绕数据流转组织
- **Effect（副作用）**：副作用必须显式声明，通过契约约束
- **Processor（处理器）**：处理逻辑通过标准化流程执行
- **Actor（执行体）**：通过 Actor 模型进行消息传递和状态管理

**为什么是 attractor：**
- DEPA 是所有 depa-* 包的共同承诺
- 违反此范式的代码难以与其他 depa 包协作
- 这四个维度构成了完整的计算模型

---

### 双层微内核架构 [dual-layer-microkernel]

**核心描述：** 系统采用两层微内核架构：
- **平台微内核（Platform Kernel）**：负责跨领域可复用的执行平台能力
- **AI 领域微内核（AI Domain Kernel）**：负责 AI runtime 特有的协作、语义与工具链能力

**这不是 Cell/Terminal 分离**，而是：
- 平台层定义"如何组合与运行"
- AI 层定义"AI runtime 到底运行什么语义"
- profile 叠加模型：`platform-only -> ai-kernel -> ai-coding`

**具体体现：**

平台微内核应包含：
- actor / fiber / mailbox / selective receive
- append-only event log / ordered timeline / reducer projection
- manifest / variant / bundle / registry composition
- profile / bootstrap / capability registry
- hook runtime / permission / policy pipeline
- diagnostics / replay / trace runtime
- persistence ports 与 support capability contract
- shell bridge 所依赖的通用 runtime contract

这些能力应优先建立在以下 vendor 原语之上：
- `depa-actor` - actor 原语
- `depa-processor` - processor 原语
- `depa-data-graph` - data-graph 原语

AI 领域微内核应包含：
- provider / model runtime
- tool calling protocol
- questionnaire / approval / human pause-resume
- AI semantic event taxonomy
- agent / member / teammate / holon 语义
- AI runtime persistence model
- AI slash namespace 与 direct action contract

目标包结构：
```
vendor/*              - 保留最底层通用原语
platform-contract     - 平台协议边界
platform-logic        - 平台内核执行逻辑
platform-support      - 本地文件 / SQLite / HTTP 等环境实现
domain-ai-contract    - AI 领域 contract
domain-ai-logic       - AI 领域 orchestration
domain-ai-support     - AI 领域环境实现
mod-platform-kernel   - 平台基线能力
mod-ai-kernel         - AI 领域基线能力
mod-ai-coding        - coding app overlay
```

**为什么是 attractor：**
- 避免未来重复搭建多套微内核
- 避免为了通用而把 AI 语义抽空
- 新领域可以复用平台微内核而不依赖 AI runtime
- AI runtime 继续作为平台上的一个领域内核存在

**反模式（明确避免）：**
- ❌ 为了未来可能复用而抽出没有真实共性的 capability
- ❌ 将 AI 领域语义硬塞进平台内核
- ❌ 在 platform 与 domain 两侧平行维护两份 registry/profile/bootstrap 真相源
- ❌ 重新造一套与 vendor 重复的 actor/dispatch/projection 基础设施
- ❌ 仅因"未来可能复用"就创建 `platform-logic`（必须有真实复用证据）

**成功标准：**
- 新领域可以复用平台微内核而不依赖 AI runtime
- AI runtime 继续作为平台上的一个领域内核存在
- shell/runtime entry 不再定义默认产品语义
- profile 成为唯一正式产品组合入口
- vendor 原语继续作为基础而不是被旁路

---

### 面向数据编程 [data-oriented-programming]

**核心描述：** 面向数据编程（DOP），数据是一等公民。代码围绕数据流转组织，副作用和数据变换显式分离。

**具体体现：**
- 数据定义优先于逻辑实现：先定义数据结构，再实现操作
- 副作用显式化：通过 `side-effect` 契约声明外部依赖
- 四层分离：
  1. **数据定义层**：类型、schema、数据结构
  2. **副作用契约层**：`*-contract` 声明 IO 边界
  3. **副作用实现层**：`*-impl` 实现契约，注入到 runtime
  4. **核心逻辑层**：纯函数式逻辑，不含副作用
- 知识图谱作为核心数据模型：所有实体通过有类型的边连接

**为什么是 attractor：**
- 数据比逻辑更稳定：数据模型演进慢于业务逻辑
- 违反此 attractor 的系统产生隐式状态和难以追踪的副作用
- DOP 使得系统行为可预测、可测试

---

### 标准化组件封装 [std-component-encapsulation]

**核心描述：** 所有业务逻辑应通过标准化组件封装流程执行：`Outer Input → Compute Derived → Transform → Core Logic → Transform → Outer Output`。

**具体体现：**
```
┌─────────────────────────────────────────────────────────────┐
│                    StdRunComponentLogic                      │
│                                                             │
│  Outer Input                                                 │
│      ↓                                                      │
│  Compute Derived                                              │
│      ↓                                                      │
│  Transform Runtime/Input/Config                              │
│      ↓                                                      │
│  Core Logic  ← 依赖通过 Runtime 显式传入                      │
│      ↓                                                      │
│  Transform Output                                            │
│      ↓                                                      │
│  Outer Output                                                │
└─────────────────────────────────────────────────────────────┘
```

- **Outer/Inner 分层**：外层处理框架级关注点，内层处理业务逻辑
- **Adapter 模式**：通过一系列 Adapter 函数完成层间转换
- **统一执行流程**：无论什么组件，都走相同的封装流程

**为什么是 attractor：**
- 统一封装流程使得所有组件行为可预测
- 违反此 attractor 的系统产生不一致的执行路径
- Adapter 模式使得层间转换可复用

---

### Runtime 显式化 [explicit-runtime]

**核心描述：** 所有依赖通过 runtime 显式传递，而非隐式的全局状态或 this 引用。`output = fn(runtime, input, config)`。

**具体体现：**
```typescript
// ❌ 传统方式（隐式依赖）
class UserService {
  createUser(data: UserData) {
    const user = db.users.create(data);  // 隐式全局依赖
    logger.info('User created');          // 隐式日志
    return user;
  }
}

// ✅ Depa 方式（显式 Runtime）
interface UserServiceRuntime {
  database: Database;
  logger: Logger;
  auditService: AuditService;
  currentUser: User;
}

async function createUser(
  runtime: UserServiceRuntime,
  input: CreateUserInput,
  config: null
): Promise<CreateUserOutput> {
  const user = await runtime.database.users.create(input.data);
  runtime.auditService.log(runtime.currentUser.id, 'CREATE_USER');
  return { user };
}
```

- Runtime 只包含必要依赖，不塞入 `everything: any`
- Runtime 按类型分组：数据依赖、逻辑依赖、副作用依赖
- 核心逻辑层不应处理框架级关注点

**为什么是 attractor：**
- 显式优于隐式：所有依赖一目了然
- 违反此 attractor 的系统产生难以追踪的隐式状态
- Runtime 使得依赖可 mock，代码可测试

---

### 多策略分发引擎 [dispatch-engine]

**核心描述：** 通过 DispatchEngine 实现灵活的请求分发，支持多种分发策略组合。

**具体体现：**

支持的 7 种分发策略：

| 策略类型 | 使用场景 | 示例 |
|---------|---------|------|
| **CLASS** | 按对象类型分发 | `UserRequest` → `UserHandler` |
| **ROUTE_KEY** | 按字符串路由键分发 | `"user.create"` → `createHandler` |
| **ENUM** | 按枚举值分发 | `UserAction.CREATE` → `createHandler` |
| **ROUTE_KEY_TO_ENUM** | 路由键转枚举后分发 | `"create"` → `CREATE` → `createHandler` |
| **COMMAND_TABLE** | 命令表模式 | `"CREATE"` → `commandTable[CREATE]` |
| **PATH** | 路径模式匹配 | `"/users/*/profile"` → `profileHandler` |
| **ACTION_PATH** | 动作+路径组合匹配 | `(POST, "/users")` → `createUserHandler` |

```typescript
const engine = new DispatchEngine<ApiResponse>();

engine
  .registerStrategy(DispatchStrategyConfig.forEnumStrategy({ ... }))
  .registerStrategy(DispatchStrategyConfig.forRouteKeyStrategy({ ... }));
```

**为什么是 attractor：**
- 策略可组合，适应不同场景
- 违反此 attractor 的系统分发逻辑硬编码
- DispatchEngine 使得新增分发策略无需修改已有代码

---

### Actor Mailbox 通信 [actor-mailbox-communication]

**核心描述：** AI agent 底层必须使用 actor 思想和 mailbox 进行 actor 间通信与控制。不可以跨过 mailbox 机制另建消息通信机制，也不能回退到传统命令式编程思想。

**具体体现：**
- 每个 actor 有自己的 mailbox（消息队列）
- Actor 间通过发送消息进行通信，而非直接调用
- 持久化控制信号：`create_timeout`/`create_interval` 通过 mailbox 调度
- `create_goal`/`update_goal` 通过 mailbox 持久化目标状态
- 禁止模式：
  - ❌ 直接 import 另一个 actor 的内部状态
  - ❌ 跨 actor 直接调用方法
  - ❌ 在 actor 外另建消息总线

**为什么是 attractor：**
- Mailbox 提供了可靠的异步通信基础
- 违反此 attractor 的系统产生隐式耦合和难以追踪的副作用
- 消息传递使得分布式和容错成为可能

---

### 消息优于命令 [message-over-command]

**核心描述：** 通过异步消息传递实现松耦合，而非同步命令调用。

**具体体现：**
- Actor 模型：每个 actor 有自己的消息队列
- Depa 协议：外部依赖通过 manifest 声明，通过协议而非硬编码交互
- 持久化控制信号：`create_timeout`/`create_interval` 提供 durable 的调度能力
- Actor surface lanes：member/holon/actor/mcp 分层接口
- TerminalStreamEvents：UI 与 runtime 通过事件流通信

**为什么是 attractor：**
- 消息传递允许自然演进
- 违反此 attractor 的系统产生隐式耦合
- 松耦合使得局部变更不会级联扩散

---

### Contract/Logic 分离 [contract-logic-separation]

**核心描述：** 每个能力模块必须将接口契约与实现逻辑分离，契约是不可变的，实现是可替换的。

**具体体现：**
- `*-contract` 包：仅定义接口、类型、契约，不含实现
- `*-logic` 或 `*-impl` 包：实现 contract 定义的接口
- Manifest 驱动：外部扩展依赖通过 manifest 声明，运行时通过 contract 实例化
- `Depa` 协议：跨包依赖通过协议而非直接 import

**为什么是 attractor：**
- 契约稳定，实现灵活：可以在不改变契约的情况下替换实现
- 违反此 attractor 的系统难以测试和演进
- 分离使得并行开发和独立演进成为可能

---

### 内聚边界 [cohesive-boundary]

**核心描述：** 每个 actor、module、context 都应有清晰的内聚边界，边界内的元素强相关，边界外的元素解耦。

**具体体现：**
- Actor 是最小独立单元：拥有自己的执行上下文、状态、消息队列
- Context 定义边界：`Boundary` + `Not Owned Here` 是每个 context 的必需章节
- 依赖规则：layering rules、dependency rules 防止跨层污染
- 分形语法：所有 modeling plane 和 implementation plane 结构同构

**为什么是 attractor：**
- 边界是模块化认知的基础
- 违反此 attractor 的系统会走向 Big Ball of Mud
- 清晰的边界使得局部变更不影响全局

---

### 框架中立性 [framework-neutrality]

**核心描述：** 底层设计必须是通用的，不应为单个业务场景破坏通用性。做机制而不是做特例。

**具体体现：**
- 系统-领域框架-业务应用 分层，不要为单个 业务场景破坏底层
- 不要为某个请求专门限制工具、压缩上下文、改变 provider 行为
- 如果问题表面上只发生在某个 app，优先寻找 runtime、provider、prompt assembly、session persistence、rx projection、protocol pipeline 中的通用根因
- 未来入口协议会继续增加，底层事实流与可观测流的设计必须支持多协议投影
- 工具列表、协议类型、可观测 sink、扩展事实类型都会继续演化，不能为了达成一次验证而限制工具或硬编码业务名称

**为什么是 attractor：**
- 通用性使得框架可以跨项目复用
- 违反此 attractor 的系统只能解决眼前问题，无法演进
- 机制设计使得系统可以应对未来变化

---

### 可验证性优先 [verifiability-first]

**核心描述：** 在实现之前必须有可验证的测试和规范，验证失败意味着方向错误。

**具体体现：**
- TDD 工作流：失败测试 → 实现通过 → 重构
- 波次执行工作流：讨论 → 规划 → 执行 → 独立验证
- 三级验证：存在性 → 实质性 → 连通性
- 测试覆盖率目标 >80%
- 阶段完成验证协议：`yield-human-confirm` / `yield-gap-loop`

**为什么是 attractor：**
- 验证提供了系统正确性的反馈回路
- 违反此 attractor 的系统难以积累信任
- 自动化验证使得持续演进成为可能

---

### 可观测优先于猜测 [observability-before-speculation]

**核心描述：** 当需要排查问题而缺少证据时，不应该盲目猜测，而是先在当前响应式可观测基座上添加新观测事实或 sink 投影，然后记录下来，再分析、排查、修复问题。

**具体体现：**
- Observability harness：可观测流作为 debug 基座，而非临时 print
- 新增观测点时先记录到 `codument/` 再分析
- `codument/troubleshooting/` 记录问题排查过程和证据
- Stream events 作为可追溯的事实流

**为什么是 attractor：**
- 证据驱动而非猜测驱动
- 违反此 attractor 的系统修复盲目、效果难测
- 观测记录使得同类问题可以快速定位

---

### Test Harness 优先 [test-harness-first]

**核心描述：** 当完整走一套流程需要很长时间时，应当建立专属测试工具或测试用例来支持未来更多同类问题。

**具体体现：**
- 测试数据分离到 `tests/resources/` 下的专门目录
- 测试 case 和代码遵循相同原则：DOP、四层分离
- 可测试性是代码质量的指标之一
- 建立测试 harness 支持回归测试

**为什么是 attractor：**
- 测试 harness 加速迭代，降低回归风险
- 违反此 attractor 的系统不敢改代码
- 测试数据分离使得测试可复用

---

### 最小化意外 [minimize-surprise]

**核心描述：** 系统行为应该是可预测的，任何非预期行为都需要明确文档化。

**具体体现：**
- 分形文档明确 `Boundary` 和 `Not Owned Here`
- 决策记录到 `codument/decisions/` 包含理由和选项
- 技术债务明确标记
- 异常行为写入 troubleshooting
- Manifest 声明所有外部依赖，显式优于隐式

**为什么是 attractor：**
- 可预测性是信任的基础
- 违反此 attractor 的系统维护成本指数增长
- 文档化使得系统行为可审计

---

### Runtime Binding 模式 [runtime-binding-pattern]

**核心描述：** 需要注册、封装、分发的关键调用节点，应遵循已有的组件封装和 runtime binding 模式，而非另起炉灶。

**具体体现：**
- 组件通过 manifest 声明，runtime 统一绑定
- Organ 注册到 runtime，而非直接实例化
- 遵循已有的 `organ-contract/organ-logic` 封装模式
- 禁止模式：
  - ❌ 硬编码依赖另一个包的具体实现
  - ❌ 在运行时动态 require 而非通过 binding

**为什么是 attractor：**
- 统一模式使得系统可理解、可维护
- 违反此 attractor 的系统产生隐式依赖
- Runtime binding 使得依赖可追踪、可替换

---

### 避免过度设计 [avoid-over-design]

**核心描述：** 标准化封装是为了解决实际问题，不是为了封装而封装。能直接实现就直接实现，不要过度抽象。

**具体体现：**

判断标准：

| 场景 | 是否需要分发 | 理由 |
|------|------------|------|
| **逻辑固定** | ❌ 不需要 | Sequence/Selector/Condition - 逻辑是确定的 |
| **需要动态路由** | ✅ 需要 | Action 节点 - 根据 ActionType 路由到不同 Handler |
| **有多种实现** | ✅ 需要 | API 路由 - 不同路径对应不同处理器 |
| **插件化** | ✅ 需要 | 支持动态注册和扩展的组件 |

**为什么是 attractor：**
- 简单优于复杂
- 违反此 attractor 的系统产生无意义的间接调用层
- 每增加一层间接调用，都会增加理解和维护成本

---

### Profile 叠加模型 [profile-layering]

**核心描述：** profile 是正式的产品组合入口，必须支持平台基线、领域基线与应用 overlay 叠加。

**具体体现：**

Profile 叠加顺序：
```
1. platform-only     - 平台内核基线
2. ai-kernel         - AI 领域内核
3. ai-coding         - coding app overlay
```

未来新领域时：
```
1. platform-only     - 平台内核基线
2. domain-x-kernel   - 领域内核
3. domain-x-app       - 领域应用
```

- 平台内核不能假定"当前领域一定是 AI"
- 各领域只需在平台基线上定义自己的 kernel 与 app overlay
- shell/runtime entry 不再定义默认产品语义

**为什么是 attractor：**
- Profile 提供了正式的产品组合入口
- 违反此 attractor 的系统通过 runtime entry 手工拼装默认产品语义
- 叠加模型使得领域扩展成为可能

---

### Vendor 原语优先 [vendor-primitives-first]

**核心描述：** 底层基础设施应优先建立在现有 vendor 原语之上，而不是平行复制同类基础设施。

**具体体现：**

优先使用：
- `vendor/depa-actor` - actor 原语
- `vendor/depa-processor` - processor 原语
- `vendor/depa-data-graph` - data-graph 原语

在这些 vendor 原语上定义更高层 contract。

**禁止：**
- ❌ 重新造一套与 vendor 重复的 actor/dispatch/projection 基础设施
- ❌ 在 platform 与 domain 两侧平行维护两份 registry/profile/bootstrap 真相源

**为什么是 attractor：**
- 复用已有的经过验证的基础设施
- 违反此 attractor 的系统产生技术债和碎片
- vendor 原语优先使得系统建立在可靠的基础上

---

## Attractor 之间的关系

```
┌────────────────────────────────────────────────────────────────┐
│                        DEPA 范式                                │
│              Data + Effect + Processor + Actor                  │
└────────────────────────────────────────────────────────────────┘
                              ↓
┌────────────────────────────────────────────────────────────────┐
│                    双层微内核架构                                │
│    Platform Kernel ←→ AI Domain Kernel                         │
│    (跨领域复用)       (AI 专属语义)                             │
│              ↕ (Profile 叠加)                                   │
│    platform-only → ai-kernel → ai-coding                       │
└────────────────────────────────────────────────────────────────┘
                              ↓
┌────────────────────────────────────────────────────────────────┐
│                    Vendor 原语优先                              │
│         depa-actor + depa-processor + depa-data-graph          │
└────────────────────────────────────────────────────────────────┘
                              ↓
┌────────────────────────────────────────────────────────────────┐
│                    标准化组件封装                               │
│   Outer Input → Derived → Transform → Core Logic → Output      │
└────────────────────────────────────────────────────────────────┘
                              ↓
┌────────────────────────────────────────────────────────────────┐
│                    Runtime 显式化                               │
│              output = fn(runtime, input, config)               │
└────────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────┐               ┌──────────────────┐
│  多策略分发引擎   │               │  Actor Mailbox    │
│  DispatchEngine  │               │    通信          │
└──────────────────┘               └──────────────────┘
          │                               │
          └───────────────┬───────────────┘
                          ↓
         ┌────────────────┼────────────────┐
         ↓                ↓                ↓
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ Runtime Binding │  │  最小化意外      │
│     模式        │  │  于直接访问     │  │                │
└─────────────────┘  └─────────────────┘  └─────────────────┘

内聚边界 ────────────────────────────────────────────────────────┐
    ↓                                                          │
    ├─→ 可验证性优先                                            │
    │       ↓                                                  │
    │       可观测优先于猜测                                   │
    │       ↓                                                  │
    │       Test Harness 优先 ────────────────────────────────┤
    │                                                          │
框架中立性 ────────────────────────────────────────────────────┘

避免过度设计 ← 贯穿所有 attractor
```

---

## 如何使用本 Attractor 文档

### 日常开发

1. **编写新代码前**：对照四层分离 + Runtime 显式化检查代码结构
2. **组件封装时**：使用 StdRunComponentLogic 标准化封装
3. **需要分发时**：使用 DispatchEngine，而非硬编码 if-else
4. **Debug 时**：优先添加可观测点，而非盲目猜测
5. **写测试前**：先建立 test harness，再写测试 case
6. **扩展时**：通过 contract + runtime binding 扩展，而非修改核心

### 架构决策

1. **架构决策前**：对照 attractors 检查决策方向
2. **代码审查时**：用 attractors 作为审查标准
3. **技术债务清理**：识别违反 attractor 的代码
4. **扩展设计时**：优先通过 contract + protocol 扩展，而非 fork 核心

### 问题排查

1. **问题出现时**：先添加观测点，收集证据
2. **根因分析**：对照四层分离定位问题所在层
3. **修复验证**：通过 test harness 验证修复

---

## Attractor 变更流程

attractor 的变更是架构层面的重大决策：

1. 在 `codument/decisions/` 创建变更提案，包含动机和影响分析
2. 讨论并记录决策理由
3. 更新 `codument/attractors/project.md`
4. 通知所有相关方
5. 必要时更新相关规范和测试

---

## 附录

### 双层微内核架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                         Profile 叠加                            │
│                                                                 │
│   ┌───────────────┐                                             │
│   │   ai-coding   │  ← app overlay (e.g., coding app)           │
│   └───────┬───────┘                                             │
│           ↓                                                      │
│   ┌───────────────┐                                             │
│   │  ai-kernel    │  ← AI domain kernel                         │
│   │               │    - provider / model runtime               │
│   │               │    - tool calling protocol                   │
│   │               │    - questionnaire / approval                │
│   │               │    - agent / member / holon 语义            │
│   └───────┬───────┘                                             │
│           ↓                                                      │
│   ┌───────────────┐                                             │
│   │ platform-only │  ← Platform kernel                          │
│   │               │    - actor / fiber / mailbox                │
│   │               │    - event log / projection                 │
│   │               │    - manifest / registry                    │
│   │               │    - profile / bootstrap                    │
│   │               │    - hook / permission / diagnostics        │
│   └───────────────┘                                             │
│           ↓                                                      │
│   ┌───────────────┐                                             │
│   │    vendor     │  ← Vendor 原语                              │
│   │   depa-*      │    - depa-actor                            │
│   │               │    - depa-processor                        │
│   │               │    - depa-data-graph                       │
│   └───────────────┘                                             │
└─────────────────────────────────────────────────────────────────┘
```

### Depa 代码模板

```typescript
// ===== Layer 1: 数据定义层 =====
interface UserData {
  id: string;
  name: string;
}

// ===== Layer 2: 副作用契约层 =====
interface UserRepositoryContract {
  findById(id: string): Promise<UserData | null>;
  save(user: UserData): Promise<void>;
}

// ===== Layer 3: 副作用实现层 =====
class InMemoryUserRepository implements UserRepositoryContract {
  private store = new Map<string, UserData>();
  
  async findById(id: string): Promise<UserData | null> {
    return this.store.get(id) ?? null;
  }
  
  async save(user: UserData): Promise<void> {
    this.store.set(user.id, user);
  }
}

// ===== Layer 4: 核心逻辑层 =====
async function createUser(
  runtime: UserServiceRuntime,
  input: CreateUserInput,
  config: null
): Promise<CreateUserOutput> {
  const user: UserData = { id: crypto.randomUUID(), name: input.name };
  await runtime.database.users.create(user);
  return { user };
}

// ===== 标准化封装 =====
class UserServiceAdapter {
  async dispatch(runtime: UserServiceRuntime, request: UserRequest) {
    return await runByFuncStyleAdapter(
      runtime,
      request,
      null,
      stdMakeNullOuterComputed,
      stdMakeIdentityInnerRuntime,
      (rt, req) => ({ data: req.userData }),
      stdMakeIdentityInnerConfig,
      createUser,
      (rt, req, cfg, derived, out) => out
    );
  }
}
```

### DispatchEngine 使用示例

```typescript
const engine = new DispatchEngine<ApiResponse>();

// 注册多种分发策略
engine
  .registerStrategy(
    DispatchStrategyConfig.forEnumStrategy({
      handlerMap: new Map([
        [UserAction.CREATE, createHandler],
        [UserAction.UPDATE, updateHandler],
        [UserAction.DELETE, deleteHandler],
      ]),
      defaultEnumHandler: defaultHandler,
    })
  )
  .registerStrategy(
    DispatchStrategyConfig.forRouteKeyStrategy({
      handlerMap: new Map([
        ['user.list', listHandler],
        ['user.search', searchHandler],
      ]),
    })
  );

// 分发请求
const result = await engine.dispatch(
  createEnumDispatchRequest(UserAction.CREATE, inputData)
);
```

### 常见陷阱警示

| 陷阱 | 问题 | 解决方案 |
|------|------|---------|
| **混淆 Cell/Terminal 与 Platform/AI Domain** | 把两层微内核理解为数据/控制分离 | 双层微内核 = 平台层(跨领域) + AI领域层(AI语义) |
| **Runtime 过度臃肿** | 塞入 `everything: any` | 只包含真正需要的依赖 |
| **Core Logic 处理框架关注点** | 在核心逻辑中做路径解析、错误处理 | 这些应在 Adapter 层处理 |
| **测试使用真实依赖** | 测试连接真实数据库 | 使用 Mock Runtime |
| **类型安全缺失** | 过度使用 `any` | 使用泛型保持类型安全 |
| **忘记处理异步** | 异步函数没有 await | 统一使用 async/await |
| **无证据创建 platform-logic** | 没有真实复用证据就创建 | 必须有第二领域验证或真实重复实现证据 |
| **平行复制 vendor 基础设施** | 重新造一套 actor/dispatch/projection | 优先使用已有的 vendor 原语 |
