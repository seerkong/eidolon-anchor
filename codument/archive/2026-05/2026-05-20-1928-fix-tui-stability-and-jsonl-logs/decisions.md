# Decisions

## Usage
- 用于记录需要确认的决策问题、选项、结论与理由
- 问题标题不用字母前缀；字母只用于选项
- 后续执行过程中出现的新决策，也继续追加到本文件，不新建分散记录

### 1. 【P0】非状态日志的归类边界
- 背景：当前热路径里有 runtime receipt、sync listen、prompt input、bootstrap 等大量日志调用。
- 需要决定：第一版迁移中，哪些日志调用要进入 JSONL append-only sink。
- 选项：
  - A) 仅按 logger namespace 白名单迁移
  - B) 逐个调用点人工迁移
  - C) 先迁移 TUI 热路径里的 diagnostics，保留少量错误/边界日志的控制台镜像
- 当前建议：C
- 用户答复：用户要求部分非状态类日志改为 JSONL append-only；未指定更细分类边界。
- 最终决策：C
- 决策理由：先处理 runtime event receipt、sync dispatch、dialog input 这类高频 diagnostics，并保留错误、启动和提交等低频日志。
- 状态：decided

### 2. 【P1】JSONL 文件布局
- 背景：append-only 日志需要易于检查，同时避免跨运行写放大。
- 需要决定：文件是按进程、按天还是按 session 切分。
- 选项：
  - A) 按进程运行切分
  - B) 按天切分
  - C) 按 session 切分
- 当前建议：A
- 用户答复：未指定文件布局。
- 最终决策：A
- 决策理由：运行实例级 JSONL 避免多个 TUI 进程争用同一个旧日志文件，同时仍可通过 `Log.path()` 定位。
- 状态：decided

### 3. 【P1】投影压降优先级
- 背景：runtime message/part 投影在长会话下会持续放大成本。
- 需要决定：先做哪种边界收紧。
- 选项：
  - A) 先去重和节流日志，再收紧投影
  - B) 先收紧投影与缓存，再改日志
  - C) 两条线并行推进
- 当前建议：C
- 用户答复：未指定优先级。
- 最终决策：C
- 决策理由：日志同步写盘和重复 no-op 投影会叠加放大卡顿风险，需一起收敛。
- 状态：decided
