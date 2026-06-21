# skill: codument-status（项目 / track 状态总览）

你是负责提供当前项目状态概览的 AI 代理。状态**全部从 track.xml 派生**：扫 `codument/tracks/` 下各 track 的 `track.xml`，读 `<Metadata><Status>` 与遍历 `<TaskSpace>` 的任务状态，给出 track 列表、任务进度、当前可执行项与恢复信息。

> 本文以 Markdown 为主（这是个读取-汇报型 skill）；仅「读取/汇报」的少量控制流用流程标记块。
>
> 口径映射（旧命令 / 旧格式 → 当前标准）：`codument:status`→`codument-status`；`plan.xml`→`track.xml`；不读 `state.json` 作为恢复点（恢复点改为 track.xml 内 `Status`）；`metadata.status` 枚举 `new|in_progress|completed|cancelled` 读自 `<Metadata><Status>`；任务状态读自 TaskSpace 节点 `status`（枚举 `NOT_STARTED|ACTIVE|DELEGATED|FORWARDED|DONE|REFUSED|ABANDONED`）；`workflow.md`→`std/sop/workflow.md`；旧 `<summary>` 已删——**不读任何手维护 summary，一切派生**。

---

## 1. 设置检查

**协议：验证 Codument 环境是否正确设置。**

1. **验证 tracks 目录：** 检查 `codument/tracks/` 是否存在。不存在则停止并提示：「项目未设置。请使用 `codument-init` skill 设置。」
2. **检查必需入口：**
   - 项目上下文：优先 `codument/attractors/`（`project.md`/`product.md`）；如该目录不存在，旧项目须同时存在 `codument/project.md` 和 `codument/product.md`。
   - 内置规程入口：`codument/std/sop/workflow.md`（旧单体 `codument/std/workflow.md` 兼容读）。
3. **处理缺失：** 若工作流规程缺失，或既没有 `codument/attractors/` 也没有旧 `project.md`/`product.md` 组合，停止并提示用户使用 `codument-init` skill。

---

## 2. 状态概览协议

接收可选参数 `track-id`（缺省汇总所有活跃 track）。状态报告**按此顺序**生成：

```text
@delimiter: --
-- #sequence ?overview
---- #step ?discover
扫 codument/tracks/*/track.xml，读各 track 的 <Metadata><Status>（new/in_progress/completed/cancelled）；指定 track-id 则只看该 track
---- /?discover
---- #step ?derive
遍历每 track 的 <TaskSpace>：按节点 status 计数（NOT_STARTED/ACTIVE/DONE/…）、按 phase（第一层 TaskGroup）汇总、按 priority 汇总；不读任何手维护 summary
---- /?derive
---- #step ?ready
结合 <Schedule>（dag 层入度为 0 的就绪节点）与 <Hooks>（待处理 cdt:HumanConfirm/cdt:GapLoop 门控），推出「现在能做什么」
---- /?ready
---- #step ?resume
据 track.xml 内 Status 识别恢复点：Status=in_progress 且存在 status=ACTIVE 的任务 = 被中断的工作，标为可续跑
---- /?resume
---- #step ?render
按 §2.3 控制台格式渲染总览（track × Status × 进度 × 下一步）；只输出，不落盘
---- /?render
-- /?overview
```

### 2.1 读取项目计划

1. **读取 active tracks：** 扫描 `codument/tracks/` 并读取各 track 的 `track.xml`。
2. **列出 tracks：** 用 `ls codument/tracks` 列出所有 tracks。
3. **读取每个 track 的任务：** 对每个 track 读取 `codument/tracks/<track_id>/track.xml`，遍历 `<TaskSpace>`。

### 2.2 解析和总结

1. **解析内容：**
   - 识别所有 tracks 及其 `<Metadata><Status>`（new/in_progress/completed/cancelled）。
   - 遍历每个 track 的 `<TaskSpace>`，统计任务数量与状态（按节点 `status` 计数）。
   - 识别当前进行中的阶段和任务（`status=ACTIVE` 的 phase/task）。
2. **生成总结：**
   - Tracks 总数。
   - 任务总数。
   - 已完成（DONE）、进行中（ACTIVE）、待处理（NOT_STARTED）的任务数量。
   - 整体进度百分比（DONE / 总任务）。

### 2.3 展示状态概览

以清晰可读的格式展示（控制台输出，不落盘）：

```text
═══════════════════════════════════════════════════════════
                    Codument 项目状态
═══════════════════════════════════════════════════════════

📅 当前时间: YYYY-MM-DD HH:MM:SS

📊 项目状态: [正常/延迟/阻塞]

───────────────────────────────────────────────────────────
                       Tracks 概览
───────────────────────────────────────────────────────────

| 状态 | Track                          | 进度      |
|------|--------------------------------|-----------|
| [~]  | add-user-auth                  | 3/5 (60%) |
| [ ]  | update-payment-flow            | 0/8 (0%)  |
| [x]  | fix-login-bug                  | 4/4 (100%)|

───────────────────────────────────────────────────────────
                       当前进度
───────────────────────────────────────────────────────────

🎯 当前 Track: add-user-auth
   当前阶段: P1 - 基础设施
   当前任务: T1.3 - 实现 JWT 验证

📋 下一步: T1.4 - 编写集成测试

⏸️  可续跑: add-user-auth（Status=in_progress，T1.3 处于 ACTIVE，曾被中断）

⚠️  阻塞: [无/具体问题描述]

───────────────────────────────────────────────────────────
                        统计
───────────────────────────────────────────────────────────

Tracks:  3 总计 | 1 进行中 | 1 待开始 | 1 已完成
任务:    17 总计 | 7 已完成 | 1 进行中 | 9 待处理
进度:    ████████░░░░░░░░░░░░ 41%

═══════════════════════════════════════════════════════════
```

进度图标约定：`[ ]` = new / 未开始、`[~]` = in_progress、`[x]` = completed、`[!]` = cancelled / 阻塞。

### 2.4 状态输出内容

状态报告必须包含：

- **当前日期/时间：** 当前时间戳。
- **项目状态：** 高级进度摘要（正常、延迟、阻塞）。
- **当前阶段和任务：** 当前 `status=ACTIVE` 的阶段和任务。
- **下一步：** 下一个待处理任务（`<Schedule>` dag 层入度 0 的就绪 `NOT_STARTED` 节点，或顺序层中下一个 `NOT_STARTED`）。
- **可续跑（恢复信息）：** track.xml `<Metadata><Status>=in_progress` 且含 `status=ACTIVE` 任务的 track——这是被中断的工作，可用 `codument-implement` 续跑（取代旧 `state.json` 恢复点）。
- **阻塞：** 任何明确标记为阻塞的项目（待处理的 `cdt:HumanConfirm`/`cdt:GapLoop` 门控、或 `REFUSED`/`ABANDONED` 任务）。
- **Tracks（总计）：** Tracks 总数及其 Status 分布。
- **任务（总计）：** 任务总数及状态分布。
- **进度：** 整体进度，格式为 已完成/总计 (百分比%)。

---

## 3. 派生与恢复说明

状态**全部派生**，不读任何手维护的 summary（旧 plan.xml 的 `<summary>` 已删）。遍历每个 `track.xml` 的 `<TaskSpace>`，按节点 `status` 计数、按 phase（第一层 TaskGroup）与 `priority` 汇总。

「现在能做什么」由 `<Schedule>` + `<Hooks>` 推出：dag 层中入度为 0 的就绪节点、以及待处理的 `cdt:HumanConfirm`/`cdt:GapLoop` 门控。

**恢复信息**取代旧 `state.json`：被中断的 track 由 track.xml 自身识别——`<Metadata><Status>=in_progress` 且某任务 `status=ACTIVE`（实现过程被打断的标志），即可续跑点。输出保持简洁（track × Status × 进度 × 下一步 × 可续跑），**只输出不落盘**。

## 4. 参考

- track 文件格式：`codument/std/spec/track-xml-spec.md`
- 续跑实现：`codument/std/operations/implement.md`
