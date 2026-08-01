## 上下文
这个变更同时覆盖稳定性、性能和日志存储方式三个面向。

- 当前 TUI 热路径会同步写日志，且日志调用分散在 runtime client、sync layer、dialog input 和 bootstrap 路径里。
- runtime 投影会把 messages/parts 全量重建为可视消息，长会话下成本会放大。
- 用户新增要求是把部分非状态类日志改成 JSONL append-only 存储，而不是继续写成同步文本日志。

## 方案概览
1. 日志分层
  - 明确区分 state-bearing data 和 non-state diagnostics
  - state-bearing data 继续走现有 runtime/session store
  - non-state diagnostics 进入 append-only JSONL sink

2. JSONL sink
  - 每条记录写成单行 JSON
  - 文件按运行实例分片，避免跨运行写放大
  - 写入使用缓冲和异步 flush，避免 `appendFileSync` 风格的阻塞
  - 保留 `--print-logs` 的控制台镜像能力，但不把它作为持久存储真相源

3. 热路径降压
  - 收缩 runtime client 和 sync layer 的事件级日志噪音
  - 只保留少量必要的错误和边界状态日志
  - 避免每个输入变更、每个事件收据都进入同步文件写盘

4. 投影与缓存边界
  - 对 runtime message/part cache 设定清理和边界策略
  - 优先增量更新可见状态，减少全量重建
  - 对 subscribe fallback 增加 abort-aware 和退避逻辑

5. 测试策略
  - 先写回归测试，覆盖日志格式、append-only 行为和事件高频压力
  - 再实现 sink、分类和投影边界

## 影响范围与修改点（Impact）
- `terminal/packages/tui/src/support/util/log.ts`
- `terminal/packages/tui/src/cli/cmd/tui/context/runtime-client.tsx`
- `terminal/packages/tui/src/cli/cmd/tui/prototype/materials/state/sync-context.tsx`
- `terminal/packages/tui/src/cli/cmd/tui/prototype/materials/state/sync-store.ts`
- `terminal/packages/tui/src/cli/cmd/tui/prototype/graph.ts`
- `terminal/packages/tui/src/cli/cmd/tui/prototype/data.ts`
- `terminal/packages/tui/src/cli/cmd/tui/ui/dialog-prompt.tsx`

## 决策摘要
- 详见 `codument/tracks/fix-tui-stability-and-jsonl-logs/decisions.md`
- 当前关键结论：非状态诊断日志采用运行实例级 JSONL append-only sink，状态数据不迁移出原有 runtime/session 存储

## 风险 / 权衡
- 风险：日志格式变化会影响本地调试习惯 -> 缓解：保留控制台镜像和稳定的字段结构
- 风险：投影边界收紧可能暴露未覆盖的状态同步问题 -> 缓解：先补回归测试，再收紧缓存策略
- 风险：subscribe fallback 的退避可能改变异常恢复时机 -> 缓解：只在异常/无事件退化路径启用退避

## 兼容性设计
- 保持 `Log` API 形状不变，先变更底层 sink 和分类策略
- 状态类 runtime/session 数据继续通过现有 store 和事件流传递
- JSONL 文件以新增路径形式落地，不覆盖现有会话内容文件

## 迁移计划
1. 先把非状态日志迁移到 JSONL sink，并保留控制台镜像。
2. 再收敛热路径日志调用和投影重建成本。
3. 最后补充清理和验证，确认长会话下不再出现持续恶化。

## 待解决问题
- 运行实例级 JSONL 文件是否需要日切或大小轮转。
- 哪些日志调用在第一版中仍应保留为文本或控制台输出。
