# Design: Provider Switch Admission and Recovery

## 现场事实

- 16:58 的Codex调用在provider transport之后失败为`provider_request_admission_observation_required`。
- common executor把`requestDigest`当作每次provider请求的admission proof，但adapter只在capture port或DeepSeek cache profile存在时安装observer。
- 18:43 的恢复现场中，session index指向epoch 5 / Codex Responses，provider transition head仍是epoch 4 / SiliconFlow DeepSeek。
- runtime snapshot callback会reassert provider epoch；model control应用后先activate epoch、后refresh adapter，可能用旧adapter推导新target profile。
- coordinator用`.catch(() => {})`吞掉snapshot失败，用户只能看到会话不再推进。

## Authority与事务边界

Conversation Domain仍是canonical authority。Provider epoch receipt与transition head是同一投影事务的identity/head，不允许独立推进。Snapshot只能引用已经提交的transition；若写入任一步失败，保留最后已知完整generation。

顺序固定为：

1. 录取model/provider control fact；
2. 构造并刷新target adapter；
3. 从target adapter读取protocol profile；
4. 比较/创建provider epoch transition；
5. 原子提交receipt、transition head及引用该generation的session snapshot；
6. 才允许下一次provider projection/transport。

## 通用Request Admission Observation

final-wire request在common transport admission处计算closed digest。digest覆盖协议定义允许的结构和值，但日志与错误只携带digest、protocol/profile、attempt identity等安全事实，不携带body内容。provider-specific observer可以追加DeepSeek cache units、usage/cost事实；没有增强observer不影响common admission proof存在。

这消除当前错误依赖：

`common request validity → DeepSeek cache observer → requestDigest`

改为：

`common final-wire admission → requestDigest`

`provider observer → optional cache/cost enrichment`

## 错误与恢复语义

- 网络发送前的projection/admission失败：保持turn可重试，不确认tool delivery。
- 网络成功但本地commit失败：记录typed commit/checkpoint failure，禁止把未完整提交generation作为恢复head。
- snapshot失败：不得吞掉；TUI/CLI显示closed error code，runtime保留last-known-good snapshot。
- fresh recovery：只从最后完整transition generation恢复adapter/profile/epoch；检测到旧式分叉时以canonical receipt校验后确定性修复，不同时信任两个head。

## 验证

- OpenAI Responses成功响应无cache observer时仍有request admission digest。
- provider control后target adapter先于profile/epoch解析刷新。
- 注入snapshot写失败，断言旧head不变且错误可见。
- 构造分叉fixture，fresh recovery收敛到一个完整generation。
- 复制事故session，分别验证Codex重试、Codex→DeepSeek、DeepSeek→Codex；原目录manifest不变。

## 2026-08-31 实现与观测

- common HTTP/Responses transport 现在在最终序列化字节的发送边界生成 `provider_request_admission_observation.requestDigest`；DeepSeek cache observation 仅作为可选增强。
- model switch 先刷新目标 adapter，再由 adapter-owned protocol profile 创建并提交 provider transition；session index 引用的 receipt digest 必须与 transition head 一致后才允许保存普通 runtime snapshot。
- runtime progress checkpoint 写失败不再被 coordinator 吞掉，调用方能够观察失败并保留最后完整 generation。
- deterministic 回归已覆盖 Responses admission、provider transition fault recovery、checkpoint failure propagation 和 model refresh 后的 receipt/head 一致性。
- 更正现场记录：PID 26884 属于 `/Users/kongweixian/work-repos/omni/omni_assistant` 的 Eidolon，并未持有目标 session。用户退出该进程后，`pgrep -x eidolon` 和目标目录 open-file 检查均为空；原现场逐文件内容指纹与名义副本一致，live recovery 只在副本上执行。
- 真实副本验证覆盖 Codex epoch 5 恢复、切换 DeepSeek epoch 6、切回 Codex epoch 7：三个阶段最终均返回指定验证答复，无工具调用或副作用重放。切回 Codex 的首次 transport 遭遇远端 HTTP 524，但同一 epoch 内重试成功；这与之前在 admission/replay 边界永久失败的故障不同。最终 session receipt digest 与 transition head 同为 `sha256:cacd2682483f7586ecb64a51c7086ffd4aa7c18f45a6b8aaba1caf57b445c164`，原现场未被修改。

## 2026-08-31 P4 交互入口纠偏

用户复验证明 P3 的 headless `eidolon exec --auto-resume` 矩阵不等价于 TUI 的真实提交路径。TUI 在选中 Primary actor 时走 `actor.send -> sendActorHumanMessage`，而不是 `session.prompt -> runtime.turn`。现有 actor 路径只发送 mailbox、做最多 250ms 的 bounded tick，然后返回发送前构造的 projection；它没有复用 `runInteractiveTurn` 的超时、human boundary、safepoint、checkpoint 和失败传播语义。

目标映射为：

1. actor surface 仅负责选择 actor 和录取 human-input signal；
2. Terminal runtime 对目标 fiber 调用同一 `runInteractiveTurn`，由 durable wake 复活 failed fiber；
3. 返回值在 settled / blocked-on-human 时重新投影，activation/provider/checkpoint/timeout 失败则 reject；
4. TUI client 只在该 Promise 完成后结束本轮，错误走现有 toast/assistant error 可观测路径，不再出现 UI-only 的幽灵用户消息。

## 2026-08-31 P5 Effective VFS 启动边界纠偏

真实 `eidolon --yolo --session 20260831145910__01M1BV03BCJMESX76FBEP5EF2E` 隔离副本显示，恢复过程尚未创建任何 MCP 子进程，主进程已经持续占用约一个 CPU 核，RSS 从约 3.5GB 增长到 7GB 以上。`--no-mcp` 在同一位置复现，证明故障属于 MCP 之前的公共 runtime 初始化，而不是 MCP、网络或 yolo 权限策略。

回归来自 `TerminalRuntime.createRuntimeBridge` 新增的 Effective VFS 准备步骤：`prepareEffectiveEidolonVfs` 把 home/workspace `.eidolon` 交给 `loadPhysicalEidolonDirectoryOverlay`。后者采用“除少数名字外递归读取所有普通文件”的开放边界；虽然后续补丁排除了 `sessions`、`skills`、`commands`，却把 `~/.eidolon/projects` 下 1143 个、约 55MB 的旧会话/缓存运行态装进 XNL VFS，并反复进行 identity、snapshot、canonical serialization、digest、diff 和 readback。

Halfcode Effective VFS 是配置与资源 authority，不是 Eidolon 所有持久化状态的镜像。物理根节点必须先分类、后遍历：

- managed configuration/resource：根配置文件、`resources` 及现有受管配置目录，允许进入 sparse overlay；
- runtime-owned state：`sessions`、`projects`，在 `readdir` entry 边界直接跳过，禁止遍历和读取后代；
- legacy external resource surfaces：`skills`、`commands` 继续由原机制管理，不进入 Effective VFS；
- atomic/transient entries：继续按临时文件规则跳过。

这里先采用显式 runtime-owned deny set，而不收紧成易破坏扩展性的全局 allowlist：新配置目录仍可 overlay，但任何新运行态根必须在其 owner 引入时声明并加入分类契约。单元测试用不可读取的 runtime-state 后代证明“未遍历”，不仅断言最终 VFS 中不存在路径。

TUI 初始化状态也按真实阶段表达：等待整个 `getRuntimeBridge` 时显示“正在初始化本地 runtime...”；只有 runtime bridge 发出 MCP 专属进度后才显示 MCP 状态。这样 Effective VFS、配置或恢复错误不会继续伪装为 MCP 卡死。
