# Conversation 规则与持久化装配归位

## 目标
消除 domain→concrete support，拆出成熟 pure materializer/repository 恢复算法，删除 persistence 模块加载副作用。保持 Prompt、历史、工具配对、上下文 fact anchors 和持久化格式。

## 影响与兼容
支持包公开的纯函数转出口可暂时指向更底层 persistence logic，不导回 organ logic。capsule registry 改为 runtime 显式参数，内部消费者同步迁移；file/memory factory 仍保留。该内部 API 调整不要求 npm 发布。

## 非目标
不改 provider 策略、提示词、压缩规则、用户 session，不处理 Holon/权限/配置剩余环（后续闭包）。manual、不 build/install/publish，不跟踪 bun.lock。
