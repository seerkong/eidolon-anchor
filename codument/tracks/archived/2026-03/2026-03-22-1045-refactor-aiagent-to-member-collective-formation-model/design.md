## 上下文

本变更是对整个 AIAgent 项目的统一重设计，目标不是在重构前分裂体系上继续叠加概念，而是彻底切换到新的 actor 心智模型。

当前问题主要有：

- 组织语义、执行语义和任务协议语义混层
- 用户需要同时理解多套重构前入口
- 重构前组织/执行/调度术语之间的边界不稳定
- 命令词不统一，派发、监听、组织管理在不同对象上使用不同表达
- runtime、tools、持久化、测试和文档长期共享旧命名，难以稳定演进
- vendor `depa-actor` 中面向 AI agent 的说明与示例无法映射到一个清晰、统一、可嵌套的业务模型

本设计的核心目标是：

- 以 actor 作为统一对外对象
- 以 `member / collective / formation` 作为唯一正式组织语义
- 以 `control actor / delegate actor / detached actor` 作为唯一正式执行语义
- 以 `assign / assign:r / assign:n / assign:s` 作为唯一正式任务派发协议
- 以 `watch / unwatch` 作为唯一正式对象级监听控制
- 彻底移除旧行为兼容与旧数据恢复承诺
- 对仍需保留的执行 helper，也按正式执行语义同步正名

## 方案概览

1. 统一对象分层
  - 所有正式业务目标都视为 actor
  - actor 分为两条正交维度：
    - 组织语义：`member / collective / formation`
    - 执行语义：`control actor / delegate actor / detached actor`
  - 对于当前 runtime 中尚未独立注册为 fiber-backed actor 的 organization object，系统通过 actor-addressable organization projection 暴露统一正式接口；formal surface 仍按 actor 心智模型对待它们

2. 统一组织语义
  - `member`
    - 单个成员 actor
    - 可直接收任务、回结果、被组织纳入
  - `collective`
    - 无 leader 的自治组织 actor
    - 通过任务板、领取、优先级与调度机制推进任务
  - `formation`
    - 有 leader 的组织 actor
    - 由 leader 或 leader 代表的协调层负责任务编排与汇总

3. 统一执行语义
  - `control actor`
    - 重构前主控执行体
    - 表示当前控制面或主控会话 actor
  - `delegate actor`
    - 重构前派生执行体
    - 表示由其他 actor 派生出来执行子任务的 actor
  - `detached actor`
     - 重构前后台执行体
     - 表示脱离当前前台交互独立运行的 actor

3.1 组织语义与执行语义正交落地
  - `member / collective / formation` 只存在于 `identity.kind`
  - `control / delegate / detached` 只存在于 `actor.type`
  - 常规 member actor 使用：
    - `identity.kind = member`
    - `actor.type = delegate`
  - 后台化 member actor 使用：
    - `identity.kind = member`
    - `actor.type = detached`
  - `control` 只保留给当前 session root / control actor，不再复用于 member

4. 统一任务协议
  - 所有 actor 派发任务统一使用 `assign`
  - 回传模式通过 `assign` 后缀区分：
    - `assign` -> final（默认 request/response）
    - `assign:r` -> final（显式 request/response）
    - `assign:n` -> none
    - `assign:s` -> stream

5. 统一监听协议
  - `watch`
    - 开启对象级持续监听
  - `unwatch`
    - 关闭对象级持续监听
  - `assign:s`
    - 既创建任务流，也自动使目标进入 watched 状态

6. 统一命令面
   - 只保留以下一级命令：
     - `/actor`
     - `/member`
     - `/collective`
     - `/formation`

6.1 统一命令对齐的底层 tool surface
   - tool 层不再以重构前工具族作为正式 API 家族
   - 底层工具直接跟随 `docs/ai/modules/AIAgent/reorg/command-spec.md` 的正式命令设计
   - 公开 tool 家族分为：
     - actor 核心工具：
       - `ActorAssign`
       - `ActorStatus`
       - `ActorWatch`
       - `ActorUnwatch`
      - member 工具：
        - `MemberCreate`
        - `MemberList`
        - `MemberStatus`
        - `MemberAssign`
     - collective 工具：
       - `CollectiveCreate`
       - `CollectiveAdd`
       - `CollectiveAssign`
       - `CollectiveStatus`
     - formation 工具：
       - `FormationCreate`
       - `FormationAdd`
       - `FormationAppoint`
       - `FormationAssign`
       - `FormationStatus`
   - `collective` 的自治调度属于组织内部能力，不再以额外工具家族对外暴露
   - 重构前派发入口不再以 rename wrapper 形式保留；任务派发统一收口到 `ActorAssign` 与各组织对象的 `Assign` 家族

7. 统一实现命名
   - runtime 类型、tool 名、变量名、metadata key、目录命名、测试命名、文档命名都切换到新词汇
   - 旧命名不保留正式兼容层

8. vendor 同步重写
  - 重写 `ACTOR-FOR-AI-AGENTS` 的概念说明
  - 重写 AI agent 相关示例与模拟测试
  - 使 vendor 示例与主项目命令协议、组织语义一致

## 影响范围与修改点（Impact）

- backend AIAgent runtime
  - actor identity
  - runtime state
  - message routing
  - event stream
  - persistence / recovery
  - 重构前模块与调用面

- composer / tools
  - tool 名称
  - tool 参数
  - runtime 查询与控制入口

- terminal / TUI / minimal
  - slash command 解析
  - 交互文案
  - 状态展示
  - 事件流展示
  - watch/unwatch 行为

- docs
  - AIAgent 模块文档
  - howto
  - 命令说明
  - 架构与概念说明

- tests
  - unit tests
  - integration tests
  - e2e / TUI tests
  - vendor 模拟测试

- vendor `depa-actor`
  - AI agent 说明文档
  - 面向 AI agent 的示例代码
  - 相关模拟测试

## 决策

- 决策：将组织语义与执行语义拆分成两条维度
  - 原因：避免 `member / collective / formation` 与 `control / delegate / detached` 混层，保证模型可扩展

- 决策：本 track 中 `collective / formation` 允许先以 organization projection 形式暴露统一 actor 接口，而不强制每个 organization 立即落成独立 runtime fiber-backed actor
  - 原因：当前 command-aligned surface、status/watch/assign 协议与持久化已经围绕 organization record 建立；在本轮收口中，先统一 formal surface 与文档真相源，比在同一轮再引入独立 organization runtime/fiber 更可控

- 决策：member 不再使用 `actor.type = control`
  - 原因：`member` 是组织身份，不是执行位阶；继续复用 `control` 会让 runtime guard、workload、transcript 与历史压缩分支持续混层

- 决策：常规 member 统一使用 `actor.type = delegate`，后台 member 使用 `actor.type = detached`
  - 原因：执行语义只表达运行方式；该策略同时贴近 root-vs-worker 的分层思路，并保留 member 的组织身份

- 决策：将 `assign` 作为唯一正式派发动词
  - 原因：降低记忆负担，避免 `send / call / stream / dispatch / broadcast` 并存

- 决策：`assign:s` 自动进入 watched 状态
  - 原因：让流式任务调用和后续持续观察自然衔接，减少手工先 `watch` 的负担

- 决策：`watch / unwatch` 只控制监听，不控制任务生命周期
  - 原因：避免监听协议与 cancel / shutdown / interrupt 混淆

- 决策：彻底 breaking change，不保留旧命令与旧实现兼容
  - 原因：用户明确要求不兼容旧行为，兼容层会快速让系统回到双模型并存

- 决策：底层 tool 不做 rename-only 迁移，而是按正式命令面重新设计
  - 原因：`docs/ai/modules/AIAgent/reorg/command-spec.md` 已将正式命令面收敛到 `/actor /member /collective /formation`，继续保留重构前公开工具只会让旧语义继续成为真实接口

- 决策：将 `MemberStatus` 明确视为 `ActorStatus` 的 typed wrapper 并纳入正式 member 工具族
  - 原因：`status` 已是正式结构管理动词；当目标已知为 member 时，typed wrapper 可降低调用歧义，同时不引入独立旧状态体系

- 决策：重构前独立调度工具族不再作为正式 API 家族存在
  - 原因：`p5-tool-implementation-design.md` 已明确调度能力应内化为 collective 能力，而不是独立概念系统

- 决策：旧数据恢复不在新运行时兼容范围内
  - 原因：旧 snapshot / session / indexes 承载的是旧模型结构，兼容恢复会显著放大实现复杂度并污染新模型

### 考虑的替代方案

- 替代方案：保留已删除一级命令作为别名
  - 放弃原因：会延续旧心智模型，增加命令面分裂

- 替代方案：把重构前公开工具仅做平移改名
  - 放弃原因：这无法完成 command-aligned tool surface 的重建，只会把旧公开 API 继续保留下来

- 替代方案：仅对外改命令，内部保留旧 runtime 命名
  - 放弃原因：实现、测试和文档会继续双语义并存

- 替代方案：保留 `send / call / stream` 作为 actor 派发词
- 放弃原因：和 `assign / assign:r / assign:n / assign:s` 相比，动词系统更分裂

- 替代方案：让 `assign:s` 仅绑定单次任务流，任务结束后不保留 watched 状态
  - 放弃原因：与用户要求不符，也会导致用户频繁重复 `watch`

## 风险 / 权衡

- 风险：一次性全改涉及模块多，回归面广
  - 缓解措施：按 runtime、tools、命令面、文档、vendor、测试分阶段落计划，并为每阶段补齐测试

- 风险：旧概念词在代码、测试、文档中残留
  - 缓解措施：将“禁止旧正式命名残留”作为独立任务与验收项，使用全文检索校验

- 风险：watch/unwatch 与 assign:s 行为边界实现不一致
  - 缓解措施：先以协议测试锁定语义，再做 TUI / terminal / runtime 一致性验证

- 风险：member 改成 delegate 后被误走普通 delegate workload / transcript / completion 分支
  - 缓解措施：优先修正 `inferFiberWorkload`、executor 分支 helper 与 member transcript 目录策略，并补 focused regressions

- 风险：旧数据不兼容会影响现有开发中的恢复体验
  - 缓解措施：在文档和错误提示中明确说明 breaking change 边界，要求新建会话

- 风险：vendor 示例和主项目实现语义漂移
  - 缓解措施：用一套共享的命令协议与概念词表重写 vendor 文档和模拟测试

## 兼容性设计

本变更不提供旧行为兼容设计。

明确不兼容的内容包括：

- 旧命令面：
  - `/team`
  - 已删除调度命令空间
  - `/bg`
  - 以及其他旧命令空间

- 旧 tool API：
  - `TeamSpawn`
  - `TeamList`
  - `TeamSend`
  - `TeamBroadcast`
  - 已删除调度工具

- 旧派发语义：
  - `send`
  - `call`
  - `stream`
  - `dispatch`
  - `broadcast`

- 旧业务名词：
  - 重构前组织/执行/调度词汇

- 旧恢复数据：
  - 旧 session
  - 旧 runtime snapshots
  - 旧 derived indexes

## 迁移计划

1. 在本 track 内固定新的正式词汇与命令规范
2. 将 runtime identity、组织模型、任务协议与事件协议切换到新模型
3. 按正式命令设计重建 command-aligned lower-level tools，并删除重构前工具族
4. 替换 tools、TUI、terminal、minimal 中的命令与交互入口
5. 重写持久化与恢复命名，移除旧数据兼容承诺
6. 重写测试体系，覆盖命令协议、事件协议、监听协议、组织语义
6. 重写 AIAgent 正式文档
7. 重写 vendor `depa-actor` 文档、示例与模拟测试
8. 通过全文扫描确认旧正式命名不再残留于正式实现层与正式文档层

回滚策略：

- 不提供运行时级别的向后兼容回滚
- 如需回滚，只能回退整个代码版本

## 待解决问题

- `control actor / delegate actor / detached actor` 在正式命令和正式目录命名中，是否全部直接使用完整短语，还是在个别实现层使用更短但仍一致的标识
- vendor `depa-actor` 的 AI agent 示例目录结构应以“教学示例”为主，还是同时提供更接近主项目组织模型的模拟工程结构
