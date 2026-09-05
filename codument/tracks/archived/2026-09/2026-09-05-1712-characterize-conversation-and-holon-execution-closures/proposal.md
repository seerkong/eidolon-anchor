# 执行闭包语义基线

Conversation 恢复/投影、Holon 文件 journal 和装配层存在双向包依赖。先建立逐文件新进程测试矩阵，覆盖消息/上下文、持久化、TaskSpace/journal 和产品接线，保存当前失败作为纠偏依据。

新增专项回归脚本，不移动生产代码、不改提示词、不真实请求 provider、不 build/install/commit；本地 lock 仍不跟踪。
