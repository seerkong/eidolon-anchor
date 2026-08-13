# Operating system context

对已部署 instance 执行 start/resume/cancel。run 使用 immutable snapshot/RunGraph；任何运行结果或临时修复都不得回写 definition。模型只选择显式 operation，runtime 校验当前状态是否合法。

operating 只接受已有 instance identity。若请求只有 published Type 而没有 instance，先切换 deploying 创建 instance；不得在 operating 调用 catalog/list/create 等被 stage policy 禁用的工具。
