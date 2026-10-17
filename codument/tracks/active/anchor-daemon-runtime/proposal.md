# Track: anchor-daemon-runtime

用户于 2026-10-08 明确授权实施已批准的 anchor-daemon-multi-workspace 设计。一个 Daemon 在 ~/.eidolon/daemon 建立 global workspace，管理多个本机业务 workspace 的会话；Bridge 的一个 Service 关联多个 Project。

Anchor 只新增控制面、工作区路由、worker 监管与限定 effects。会话继续使用现有 HostPort、共享 SessionRuntimeAssembly、VM/coordinator/数据流与各工作区的原存储。一个 HTTP listener，内部 workspace worker 不另开 server。globalRoot 与 global workspace 分开，home VFS 排除 daemon 私有状态。跨区请求/游标/附件/命令和过期代际拒绝；连接/目录刷新无模型执行；崩溃恢复不重发未知工作。

保留 serve/TUI；session writer lease 继续裁决竞争。默认 loopback 私有 bearer，同源 Bridge BFF；不实现多人、任意远程操作、开机自启、全局 Bot/记忆/Holon 组织树。用户授权可沿用 gpt-5.6-terra medium，验收仅隔离 home/workspaces。

本 Track 是 Anchor 子范围的实现与验证记录，不成为跨项目 mission 的第二权威。提交模式 manual；用户已授权施工前保存现场，基线 64d1c87。
