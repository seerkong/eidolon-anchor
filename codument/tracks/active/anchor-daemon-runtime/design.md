# Design: anchor-daemon-runtime

一个 daemon listener 经认证/closed schema/scope resolver，选择注册的 workspace Host proxy。Supervisor 拥有注册/lifecycle，support 实现 SQLite registry、内核 lease、worker IPC 和文件/进程 effects；会话业务权威留在原 runtime。

每 workspace 一个受监管 worker，复用 createHost。选择依据：SessionRuntimeAssembly 存在 sessionKey 模块 Map，权限配置 store 与 MCP debug 也在模块作用域；不以同进程多 Host 假定隔离。Bun CLI 内部 worker 入口必须同时支持源码和编译发行物。IPC 仅公开 Host 操作、pull stream 和资源 lease，无任意函数/argv RPC。

目录 identity=canonical realpath，workspaceKey=持久路由键；daemonId 持久，daemonInstanceId 每次启动改变，workspace generation 是其 Host serverInstanceId。旧 serve 路由保持 /v1，Daemon 身份/停止为 /v1/daemon，工作区控制为 /v1/workspaces，业务为 /v1/workspaces/:key/<原 Host 资源>；认证的外层 scope 先验证再执行原 admission。服务启动身份不能替代 workspace Host 身份。

globalRoot 默认为 ~/.eidolon，global workspace 为其 daemon 子目录；registry/credential/discovery 位于 daemon/.eidolon/projects/daemon-control，业务历史仍在业务目录。排除 home daemon 与 workspace runtime 状态，保护 credential 不进入 VFS/模型/日志。Registry 只恢复登记，不重建 turn 执行。现有 Web execution-origin quarantine、goal 与 heartbeat 恢复需要负向证据。

Anchor tests/daemon 覆盖目录/CLI/worker、跨区 scope、effects 并发、崩溃恢复与原 tests/runtime-host、tests/web-shell。跨项目真实 E2E 使用一个监听地址、G/A/B 三 workspace 和真实模型，保留拓扑与响应证据；不得以原型或三条同 workspace 别名替代。阶段末 fresh AttractorCheck 使用 coding profile，仅只读审查。
