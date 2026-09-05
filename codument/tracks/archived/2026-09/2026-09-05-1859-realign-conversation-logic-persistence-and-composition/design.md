# Conversation 迁移映射

## 旧逻辑到新位置
| 原文件（cell/packages 下） | 新位置/职责 |
|---|---|
| ai-support/src/conversation/local/LocalConversationRuntime.ts 的 materialize/committed conversion/helpers | ai-persistence-logic/src/ConversationProjection.ts；纯值变换，无 FS/clock/random/具体仓库 |
| 同文件 loadConversationSessionRawState/loadConversationActorRawState | ai-persistence-logic/src/ConversationRecovery.ts；只调用显式 ConversationPersistenceRepository，support 继续实现物理 IO |
| 同文件 load history/runtime messages 与 compaction | 保留本地外层：路径、时钟/ID 和仓库事务；调用唯一 pure implementation，旧导出可指向更低层，不回流 organ |
| organ conversationCapsule/internals/domainRuntime.ts、derivations.ts | 精确导入 persistence logic；已有 repository 入参就是 effect port，不再复制一套 loader interface |
| core-contract runtime/ConversationSpineContracts.ts | typed per-runtime persistence adapter registry，替代 unknown dependencies |
| organ conversationCapsule/adapterRegistry.ts/coreLogic.ts/adapters/inMemory.ts | 显式创建/注册/解析实例 registry；不保留全局 fallback 或加载时注册 |
| support LocalConversationPersistenceAdapter.ts | 只导出具体 factory，不导入 organ registry |

## DEPA 与生命周期
持久 repository owns generations/heads/receipt；live runtime 经 restore 更新；pure projector 不能写权威。现有 ai-persistence-logic 已为 backplane，作为 shared 规则位置避免 support→organ 重建环，不新增包。多 runtime 的 adapter map 独立；未知 enum 显式报错，不默默 fallback。Terminal 产品原已直接注入 repository factory，不应为一个仅 tests 使用的 capsule 入口增加全局初始化。

## 验证与推进
P1-T1/P1-T2 文件闭包互不交叉，可并行；各自先验证原测试再补架构/实例隔离反例。最终跑完整 characterization 矩阵。保留旧 wire golden，不能更新 golden 消除差异。阶段 GapLoop verify_round=true 与 coding AttractorCheck；modeling/engineering 均关闭。

## 兼容约束
导出位置的内部调用方全部检查。支持包兼容导出只可指向更低层公开面，不能用相对路径或延迟 import 藏回边。适配器 API 的显式参数同步测试调用者；提交 manual，无 build/install/发布。
