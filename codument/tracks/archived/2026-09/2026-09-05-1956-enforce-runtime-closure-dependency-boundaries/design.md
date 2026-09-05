# 配置与权限闭包归位

## 映射与依据

以 cell/packages 为根：

- ai-support/src/runtime/LocalFileRuntimeConfigLoader.ts:10 导入 organ ModelConfigOps 的 load/resolve。原 ai-organ-logic/src/llm/ModelConfigOps.ts 同时含纯 schema/parse/flatten/resolve 与 fs/os/path。按函数依赖机械拆分：纯规则进 ai-core-logic/src/llm/ModelConfigRules.ts；文件选择/load/refresh 进 ai-support/src/runtime/LocalModelConfigFiles.ts。旧 ModelConfigOps facade 指向两者的同一实现。
- ProviderOptions 与 DeepSeekModelCapabilities 是纯模型规则的实际依赖，同步迁至 core-logic 对应 llm 目录，旧 organ 子路径只转出口。core-logic 直接声明所用 organ-contract 类型依赖；contract 不依赖 core-logic，因此不重建运行时环。不借类型导入掩盖 manifest 边。
- ai-support/src/permissions/LocalFilePermissionConfigStore.ts:12 导入 organ LocalPermissionConfig。原模块 parse/serialize/normalize 进入 core-logic/src/permissions/LocalPermissionRules.ts；依赖 HOME 的路径展开和 filesystem grantRoot 留 support。原 organ facade 保留原 store 配置调用者，不新增隐式注册。配置实例化和授权策略不是这次迁移目标，不能因拆分改变其行为。

权限原 parse 的 path.resolve(relative) 隐式读取 cwd。lower 规则必须显式接收 cwd（或等价 typed path runtime），支持层/facade 在每次调用取得原 process.cwd 并传入；不能默认在纯规则内部读取环境，也不能改为相对于配置文件解释路径。新增 relative/absolute/cwd 变化回归固定原语义。

## 事实与效果

配置文件仍是输入 authority；解析结果是值，不回写文件。权限文件写入仍经 LocalPermissionConfigStore，路径规则、排序、allow/deny/ask 不变。secret redaction 和 recovered option 合并保留完整函数与测试。未知 provider、模型、缺失配置仍遵循原错误与 fallback，不引入按 provider 名的特例。

## 依赖与门禁

support 可依赖 core logic/contract 与 organ contract，不能依赖 organ logic；selected Conversation domain 和 Holon rule files 不能依赖 support。宿主组合与未迁移范围不虚报为 pure logic。检查同时考虑 static import、type import、export-from、相对跨包和 manifest；禁止通过扩 allowlist 或省略 exports 边获得绿灯。测试含注入坏边应失败的反例。

两个独立判据不得混淆：selected rule/effect 的实际源码闭包应无循环；manifest 门禁是移除并禁止 support→organ-logic 回边，不是宣称整个包图 DAG。已有 ai-core-contract↔ai-organ-contract manifest SCC（runtimeComposer、ConversationProjectionReadPort 等跨域契约）在报告中原样显示，不能隐藏进 allowlist。本 Track 不迁移整个契约体系；新增 core-logic→organ-contract 类型边原已有经 core-contract 可达，不新增 SCC。残余契约整理是后续独立真实闭包，不冒充本 Mission 完成成果。

## 执行

实际 AST 门禁另发现选定 Conversation 文件仍经类型 facade 构成源码 SCC：domainRuntime/derivations → ConversationDomainRuntime（同时拥有类型和 coreLogic 转出口）→ coreLogic → internals。将原类型声明逐字迁到原 conversation owner 的 ConversationDomainRuntimeTypes.ts；旧 facade 同实现 type/value 转出口，internals 直接引用 ConversationDomainRuntimeTypes。该定向整理属于 T3“兼容出口背后的剩余反向边”，不改变任何值函数。门禁拒绝任何包含选定 rule/effect 文件的 SCC；其他历史 SCC 全量报告，不宣称整个工程无环。

G4 完成后执行。本 Track 两个规则拆分任务独立，父层统一维护 manifest/exports 与边界测试。先跑原有 tests，再机械迁移，新 test 验证 lower 纯规则无文件调用、cold import 不触发注册和实际文件读取优先级。保留现存未跟踪 JS，所有 TypeScript 检查 noEmit，不用不兼容的缓存 tsc，不安装发布依赖。
