# DEPA 边界与处置

## DataTopology
| 节点 | 语义角色 / authority model | Owner / transition | 关系与生命周期 |
|---|---|---|---|
| Canonical Conversation | 外部持久 authority | 既有 Conversation 领域 | 只读投影到 pages；滚动包不能写入 |
| ScrollControlState | runtime_control / memory_authority | 每个列表一个 owner，经 dispatch/消息输入 | 派生窗口；source 切换销毁，不承诺跨进程恢复 |
| 页面及 live 缓存 | derived_observation / bounded cache | controller 接收经校验页面后管理 | 不改变源顺序/分支；有界淘汰并可重取 |
| OpenTUI 几何 | renderer observation | support 订阅真实 layout/scroll | 观测输入 owner，不能偷偷改 intent |
| 挂载集合与 spacers | derived_observation | logic 纯计算 | 一份高度/坐标规则；不可反写上游历史 |
| 诊断 trace | historical_record，非 authority | 注入 sink | 只记录 id/几何/时序，限制容量，默认不含正文 |

原代码的几处物理写点不是自动等于多个 owner；问题是 native scroll 与虚拟投影缺乏完整的受控转换关系，follow/page/live 独立裁决相互冲突。本次明确这些关系，不以“多 setSignal”本身作为缺陷证据。

## DEPA 维度与字段归位
- Data：Row/Page/Anchor/Viewport/Intent/RequestIdentity 显式；authority 与缓存分开。
- Effect：文件分页、renderer 操作、订阅与诊断均是注入能力，core 不直接 IO。
- Processor：用 runtime-first 纯转换计算 state/window/effect request；固定几何算法不强套策略注册表。
- Actor：每个列表有串行输入边界；异步请求完成/取消等通过现有原语返回 owner。不是 provider actor，不需要 AI 定义或 durable checkpoint。
- runtime：state 引用、page/viewport effect、diagnostic sink；input：本次操作/观测/结果；config：overscan、缓存上限等标量。
- ReactiveDataGraphProfile 已激活：现有 view 使用 Solid signal/memo，宿主也使用 graph signals。新包装只暴露只读状态，订阅、错误、dispose 必须可测。
- EventSourcedStateProfile 对瞬态滚动状态不适用；领域 Conversation 的既有恢复规则保持原样。诊断 trace 不成为 replay authority。
- 避免过度设计：不提取通用 platform kernel、不创建备用 provider、禁止以全量挂载解决空白；capability 只包含本次被两个原型消费者实际使用的边界。

## 包级盘点与处置
当前公开滚动包不存在；滚动相关 state、effect、processor 混在 tui 业务壳内。
- ADD-CONTRACT：depa-scroll-contract 提供框架中立的公开 schema 与 effect ports。
- EXTRACT：depa-scroll-logic 接收纯算法与受控状态转换；不 import tui 消息类型。
- EXTRACT-SUPPORT：depa-scroll-opentui-support 回指 viewport/measurement/scroll effect contract。
- COMPOSE：depa-scroll-opentui-capsule 组合真实运行闭包，不持有 Conversation authority。
- RETAIN/ADAPT：tui 保留消息卡片、模型标签、权限/问卷和页面语义转换。
- REMOVE：P4 后删除散落的双重 follow/page/measurement 状态和不再使用的旧算法。
- KEEP-PRIVATE：原型应用不发布；不因创建库而顺带发布 Eidolon 或原型。

不需要新独立 adapter 包：业务映射只有 Eidolon 一方使用，先作为该宿主的内聚模块；OpenTUI support 首要职责是实现 effect，不仅是类型转换。
