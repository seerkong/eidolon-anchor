# Eidolon 业务宿主接入

宿主保留业务状态与副作用；Anchor 原 actor/tool executor 等待对应调用的真实回执，并继续原推理轮。Bridge 提供注册、观察、卡片动作和宿主 SDK。这里没有新的模型执行循环。

## 前置条件

Native capabilities 的 `features.hostInteractions` 为 true；选定 session/epoch 和允许 `host_interaction` 的 actor。旧服务没有该能力时明确不可用。BFF 凭证留在服务端，浏览器仅使用原同源 browser-session/CSRF；不能在业务页面复制 Native token。

在 Bridge 工作区执行 `bun run --cwd frontend/packages/eidolon build`，产出 `dist/host-sdk.js`，部署时同时提供其导入的 `dist/assets/`。SDK 导出 `createAnchorBrowserClient`、`createHostIntegration`、`installHostFrameBridge` 和 `connectHostFrameBridge`。API 的准确类型见 bridge-web-capsule 源码及 Native 公开 HostInteractions DTO。

## 注册能力与状态摘要

`createHostIntegration` 使用固定 sourceId/sessionId/epoch/actorId/hostId/origin 和 transport。transport.read 调用原 BFF `GET /api/anchor/v1/connections/:cid/sessions/:sid/host-interactions?expectedEpoch=...`。transport.command 通过原 commands POST 提交 `kind: host_interaction`，payload 包含 actorId 和序列化 operationJson，并查询原 commandStatus，确认 applied。

工具描述包含 name、access (`read` 或 `write`)、description、inputSchemaJson；run 是宿主代码提供的已注册函数，模型不能提供函数或任意代码。输入使用原 Anchor AgentExecutionContract 校验器。context 声明 visibility；只有 llm 摘要会调用 project 并回传，private 不读取。摘要每字段最多 2400 字节、整体 7500 字节，版本单调递增。

存储参数必须提供可读写的持久 storage。先持久化 executing 标记，再提交原 start，核实 Native 执行状态后才运行业务函数。真实结果先写入本地原回执日志，再发送 receipt。宿主需要为业务写入提供自己的幂等键或事务边界；unknown 不能自动重做。

## 跨 origin iframe

父页面安装 `installHostFrameBridge`，指定准确 iframe Window、frameOrigin、scope、工具与 storage。iframe 使用 `connectHostFrameBridge`，指定准确 parent Window、parentOrigin 和同一 scope；工具通过该 MessageChannel 注册到 integration。随后调用 integration.start。不得用 wildcard origin。父页在 iframe 导航前安装监听器。双方卸载时调用 close。

握手检查 origin、Window、scope、nonce。父页另存原 invocation 的结果；重连收到相同调用只返回原结果。错误来源、不同 actor、未知工具、非 executing 状态和身份冲突均拒绝。

## Agent 与用户卡片

原 buildToolset 只向当前 principal/actor 暴露其注册描述和最新摘要。Agent 用 `HostTool({hostId,toolName,inputJson})` 请求宿主工具，或用 `InteractionCard({hostId,toolName,inputJson,kind,title,bodyJson})` 请求通用卡片。kind 支持 draft、approval、frontend_write_confirmation。卡片对应实际已注册工具；写入和所有卡片等待用户确认。

普通会话的“宿主请求”入口显示待确认或 unknown，运行工作栏显示原 toolCallId、状态、revision、原 input 和实际 receipt。更新展示内容仅修改 bodyJson，不能改变已经授权的原 input。confirm、patch、cancel、start、receipt 都带 expectedRevision。陈旧卡片动作拒绝；cancel 在执行中标为 unknown，不声称撤销已发生的业务写入。

## 恢复与边界

刷新恢复原 Native VM snapshot 和宿主回执日志，不重跑完成或执行结果不明的函数。丢失 ACK 只重传相同 receiptId/resultJson；结果冲突拒绝。Native 重启把未结调用标为 unknown，旧推理 Promise 不伪造恢复成功。晚到回执可以完善原调用事实，不能启动新的推理轮。切换 endpoint/session/epoch 后旧 UI 动作失效。

最多 16 个宿主、每宿主 32 个工具、256 个调用；输入与结果最多 32 KiB，总状态最多 512 KiB。容量达到上限明确拒绝，不自动删除历史记录。

问卷走原 Questionnaire parser；主 Eidolon 支持多选和类型默认值，Vue/Bots 使用明确的自由文本降级。观察 watchdog 只恢复 GET：headers 30 秒、首次帧 30 秒、有效流静默 45 秒。先按原 cursor 恢复；空 replay tail 超时后改读新 snapshot，不重发业务命令。

验证入口：`bun tests/web-protocol-missions/regression.mjs`，以及每 mission 的 verify/browser 命令。浏览器测试使用隔离 Native/BFF、真实构建 UI 与跨 origin 宿主；供应商是纯本地适配器，不能据此宣称真实付费供应商已经验证。
