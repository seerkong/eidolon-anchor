# Mission：执行闭包的职责与依赖归位

## 背景
用户将第 4 项独立成 Mission。当前已证实 Conversation domain logic 直接消费 ai-support、support 导入 logic 并执行加载时注册、具体 File journal 位于 logic。问题是实际职责/依赖方向，不是仅包名不统一。必须保留已有成熟运行语义。

## 目标
- 一次整理一个真实执行闭包，显式区分 contract、纯 rules/Processor、side-effect implementation、边界 adapter、composition。
- 优先 Conversation 的 Prompt/history 与 persistence 组合，以及 Holon 的 journal/runtime bootstrap。
- 消除选定闭包的实际源码/manifest 环和加载时注册隐式依赖；通过显式 runtime/ports 连接。
- 迁移前后稳定 Prompt、dynamic context splice、tool pairing、TaskSpace/accepted-effect、shared/fresh continuity 与恢复语义等价。
- 为已归位闭包建立可执行依赖与冷启动验收，防止环通过 re-export、延迟 import 或 service locator 回流。

## 非目标与硬约束
- bun.lock 不纳入版本管理，保留本地未发布依赖开发，不引入 registry-only 或强制 frozen install 前置。
- 不全库重写、改名、抽“未来平台”；不因 composer/organ/cli 等历史后缀单独创建迁移任务。
- 不实现任务诊断/资源自主演进功能；它们归独立 Mission `evolve-holon-task-repair-and-resource-autonomy`。
- 不改历史持久格式、事实 authority、任务 identity 或 provider 语义；若真的必须改变，应证据 replan，不能藏在重构中。
- 不创建空 capsule、不将 adapter 放回被适配项目，不发布上层业务应用。
- 初始请求仅创建 pending Mission；后续用户已明确授权 impl-mission 并多次要求续跑，因此当前执行包含实现和测试。提交仍为 manual，不自动 build/local:install/commit/publish。

## 成功判据
1. 每个选定闭包有现状→目标代码映射、真实消费者、owner/port/physical IO 与禁止边清单。
2. Conversation domain core 不导入 concrete ai-support loader/materializer；pure Prompt/history rules 可无文件 IO 独立测试。
3. Holon File journal IO 位于实现其 contract 的 support；canonical Processor 不直接构造 concrete file stores。
4. 注册、依赖选择和生命周期组合在显式宿主/真实 capsule；选定边界不存在 import-time registration 和隐蔽 service locator。
5. 所有被声明要删除的源码/manifest 反向边都被测试证实删除；不能只改扫描白名单或 exports 别名。
6. 相同输入下 provider wire/order、tool pairs、fact anchors、task/journal receipts 等价；不同入口冷启动、fork/rewind、shared/fresh Member、独立 Holon 与 Ctrl/Data 恢复无回归。
7. 本地未发布依赖形态可用，类型检查不在源码旁输出文件；Git 未跟踪 bun.lock。
8. 不把局部无环夸成全库无环；超范围剩余发现明确登记，真正阻碍当前闭包完成的边继续 replan 消除。

## 为什么是 Mission
多个真实执行闭包逐一迁移，需要先固定语义基线，再依据剩余环与并行功能变化反复校验。Mission 负责控制面和跨 Track 编排；产品代码、规范与测试由真实 Track 落地；没有在普通 Mission 任务中隐式直接改产品代码的例外。
