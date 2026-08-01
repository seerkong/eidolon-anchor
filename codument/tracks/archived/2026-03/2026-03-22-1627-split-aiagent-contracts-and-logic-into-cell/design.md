## 上下文

当前 AIAgent 代码主要分布在两个来源：
- `backend/packages/core/src/modules/AIAgent`
- `backend/packages/organ/src/AIAgent`

这两个来源同时承载了类型契约、协议常量、事件模型、stream 基础抽象、runtime 基础设施、orchestrator、organization、llm、mcp、persistence、tool 执行等内容。虽然 `cell/packages/*` 已经创建了新的包骨架，但 AIAgent 领域尚未按新的分层真正落位。

本次变更的约束是：
- 必须一次性切换到 `@cell/*`
- 不保留旧路径兼容层
- 迁移边界按依赖关系划分，而不是按现有目录名照搬
- `organ-contract-low` 表达引擎级底层契约
- `core-contract` 表达 AIAgent 领域核心底层契约，并允许依赖 `organ-contract-low`

## 方案概览
1. 建立新的 AIAgent 分层判定规则
  - `organ-contract-low`
    - 放置不依赖 `core-contract` 的引擎级底层契约
    - 包括可以从 stream 体系中剥离出的底层流契约、基础事件接口、底层协议抽象
  - `core-contract`
    - 放置 AIAgent 领域核心契约
    - 包括类型定义、接口、协议常量、领域事件、配置契约、AIAgent runtime 对外约束
    - 允许依赖 `organ-contract-low`
  - `organ-contract-high`
    - 放置组织域高层契约
    - 表达 collective / formation / member / protocol / plan approval / shutdown 等高层组织约束
    - 可以依赖 `organ-contract-low` 与 `core-contract`
  - `core-logic`
    - 放置 `backend/core` 里的运行时逻辑、注册器、实现类、加载器、stream 实现
  - `organ-logic`
    - 放置 `backend/organ` 中拆分契约后的剩余逻辑、适配器与组织运行逻辑

2. 先做“分类表”，再做物理迁移
  - 先逐文件建立 mapping
  - 对混合文件按“是否包含运行时行为”进一步拆分
  - 对同时包含契约与行为的文件，优先拆出 contract 文件，再迁移 logic 文件

3. 优先处理最底层依赖
  - 第一步迁移 `organ-contract-low`
  - 第二步迁移 `core-contract`
  - 第三步迁移 `organ-contract-high`
  - 第四步迁移 `core-logic`
  - 第五步迁移 `organ-logic`
  - 最后统一改写 imports / exports / tsconfig paths / package exports

4. 一次性切换调用方
  - `backend/packages/composer/src/modules/AIAgent/**/*`
  - `backend/packages/organ/tests/AIAgent/**/*`
  - `terminal/packages/organ/src/AIAgent/**/*`
  - `terminal/packages/tui/src/runtime/**/*`
  - 其他直接依赖旧路径的代码
  - 所有调用方直接切到 `@cell/*`

5. 用导出面强制新边界
  - 每个 `@cell/*` 包通过 `package.json` 的 `exports` 暴露正式入口
  - 同步更新 `cell/tsconfig.json` 路径映射
  - 在需要消费 `@cell/*` 的 workspace 中补齐 TS path 或 package 依赖

6. 通过测试和类型检查验证迁移
  - 优先修复受影响测试
  - 确认新的导入路径和导出面覆盖现有使用场景
  - 不接受“代码已搬动但引用仍回退旧路径”的半完成状态

## 影响范围与修改点（Impact）
- 新增/完善 `cell/packages/*` 下 AIAgent 相关源码结构
- 重写 `cell` workspace 的包导出与路径映射
- 修改 `backend/packages/core`、`backend/packages/organ`、`backend/packages/composer` 的依赖与导入
- 修改 `terminal/packages/organ`、`terminal/packages/tui` 的导入
- 修改相关测试文件的导入路径
- 可能需要删除或清空旧目录中的 AIAgent 实现文件，避免旧路径继续被消费

## 决策
- 决策：按依赖层次而不是按旧目录物理位置划分包
- 理由：旧目录中的 `core` 与 `organ` 已经不再等价于新的领域层次，继续沿用会把历史耦合复制到 `cell`

- 决策：`organ-contract-low` 允许容纳 stream 底层契约
- 理由：用户已明确要求按依赖关系划分；stream 中与底层引擎抽象直接相关的契约更适合作为底层组织/引擎约束

- 决策：不保留兼容层，直接切换所有调用方
- 理由：本次目标是让 `cell` 成为唯一源头；兼容层会掩盖分层错误并延长双轨维护期

- 考虑的替代方案：保留 `@backend/*` 到 `@cell/*` 的 re-export 过渡层
- 理由：虽然迁移成本更低，但会让依赖边界继续模糊，不符合本次一次性切换目标

- 考虑的替代方案：仅先移动文件，后续再处理 imports
- 理由：会形成长时间不可验证状态，不符合本次 Track 的完成标准

## 风险 / 权衡
- 风险：部分文件同时承载契约与逻辑，拆分边界不清
  → 缓解措施：先产出逐文件分类表，再逐步搬迁，必要时拆文件而不是整文件平移

- 风险：旧路径引用点很多，改写不全会导致编译或测试失败
  → 缓解措施：先用全局检索建立引用清单，再分 workspace 改写并验证

- 风险：`core-contract` 与 `organ-contract-high` 的边界可能在迁移中反复调整
  → 缓解措施：统一用“是否属于 AIAgent 核心领域契约”和“是否表达高层组织语义”两条规则裁决

- 风险：一次性切换不保留兼容层，短期失败面大
  → 缓解措施：严格按依赖层自底向上迁移，并在每个关键层完成后跑测试/类型检查

## 兼容性设计
- 本次不提供旧路径兼容层
- 兼容性策略为“同一提交内全量切换调用方”
- 如果发现必须保留兼容层才能推进，应视为偏离本 Track 目标，需要回到规范层重新确认

## 迁移计划
1. 盘点 `backend/core` 与 `backend/organ` 的 AIAgent 文件及其引用
2. 形成文件级分类映射
3. 迁移 `organ-contract-low`
4. 迁移 `core-contract`
5. 迁移 `organ-contract-high`
6. 迁移 `core-logic`
7. 迁移 `organ-logic`
8. 更新所有调用方 imports / exports / package 依赖 / TS paths
9. 删除旧路径的正式来源角色
10. 运行测试与类型检查并修复问题

## 待解决问题
- `backend/packages/core/src/modules/AIAgent/protocol.ts` 中哪些部分应视为核心契约，哪些应下沉到 `organ-contract-low`
- `StreamEvents.ts`、`stream/stream.ts`、`stream/StreamPipeline.ts` 等文件中哪些抽象应进入底层契约层
- 旧 `backend/packages/core` 与 `backend/packages/organ` 的 `package.json` 是否需要立即去除对相关源码路径的导出
