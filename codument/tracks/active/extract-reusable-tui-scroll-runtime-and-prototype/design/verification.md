# 验证矩阵与集成门槛

## 测试层
1. 核心层：假 page/viewport ports、受控时钟、确定性输入序列；纯逻辑断言与随机交错属性测试。
2. 原型层：真实 OpenTUI/Solid renderer、真实布局与滚动入口，页面源可控。普通日志和聊天形状数据消费相同 capsule；不启动 MCP/provider/Holon。
3. 集成层：真实 Eidolon 卡片与只读 Conversation 投影；真实会话副本，不发送实际付费 LLM 请求也能注入合法 live projection 事件验证显示。

## 必测矩阵
| 编号 | 场景 | 核心可观察断言 |
|---|---|---|
| V01 | 恢复尾页，末条短/120行/800行，多条混合高度 | 内容与尾部底边可达；非空数据不可稳定停在纯 spacer，单条长卡占屏不误判 |
| V02 | wheel、PageUp/Down、Home/End、scrollbar drag、原生布局 clamp | 每条路径同步真实坐标与挂载 window，不依靠另一次键盘事件解锁 |
| V03 | 连续向上到第一条，缓存超过4页 | 每页去重、有进展、有加载反馈；锚点不跳；到首条明确 exhausted |
| V04 | 向上淘汰新页后再向下 | 能连续重取相邻新页直到最新，不丢中间记录、不全量读库 |
| V05 | prepend 等待期间继续滚动、切 session/actor | 旧 intent 校正不得抢位置；跨身份响应、measurement、排队 effect 全部丢弃 |
| V06 | 宽度缩放、工具折叠展开、流式转完成 | revision/width 缓存失效；间距和边框只计一次；browse 锚点稳定，follow 尾部稳定 |
| V07 | 浏览旧页时 live append/update，然后 End 或发送新消息 | 阅读不被抢；未读状态更新；显式操作后最新用户/assistant/tool 可见且 ID 去重 |
| V08 | stale_cursor 在缓存含尾页或不含尾页两种状态出现 | 都能显式 refresh/retry，不能清 hasPrevious 后永久困住 |
| V09 | 读取超时、拒绝、空过滤页、预算错误、取消 | loading 收口；错误可见/可重试；cursor 不进展时停止循环并报告，不忙等 |
| V10 | 反复 mount/dispose、restore、切 actor | resize/scroll listener 回到基线，无 disposed 写入；旧请求不阻塞新 source |
| V11 | 大规模长会话与长时间 live 更新 | row mount、页面正文、measurement/trace 缓存均有界；正文容量和 mounted 节点分别测量 |
| V12 | 中文宽字符、Markdown、代码块、工具卡以及 composer 高度变化 | 以真实内容 viewport 测量，不拿终端总高度替代；底边不被 composer 永久遮挡 |
| V13 | fork/rewind/compaction 后双向分页 | active actor/generation 隔离保持；不能从旧 cursor 泄漏不可见尾部 |
| V14 | renderer 坐标变化但没有业务 handler 触发 | 下一次布局观测即可重建正确 window，长卡数据不再产生持续空白 |

## 可执行门槛
- P1 写入 baseline：固定环境/数据种子、测试命令、依赖版本、帧采样规则。前期“诊断打印成功”不能算断言测试。
- 稳定尺寸的合成场景：滚动/几何观测后最多2个完整布局观测周期内，挂载区域应覆盖实际可见的数据区；动态尺寸收敛次数另行记录，不能用任意 sleep 掩盖不收敛。
- 原型默认40行/页、最多4页正文缓存；overscan 默认上下各1个 viewport。挂载数不超过该几何区间相交的 row 数加2个边界 row。不得随历史总量线性增长。
- 1,000/10,000/100,000条索引数据比较，记录 P50/P95 交互到稳定帧、最大事件循环停顿、首屏可交互时间、观察字节、峰值内存和 listener 数；数据源不得预先创建全部 renderable。
- 大数据初始化/翻页必须给事件循环让出执行机会；受控测试在未完成分页期间可处理取消、输入和 beacon tick。P1 根据基线在实施优化前锁定耗时阈值及环境，不能事后降低门槛来制造 PASS。
- 长时间压力序列至少100次分页/更新交错、50次 source 切换与 dispose，检查泄漏和 stale effects。
- 核心行覆盖目标不低于80%，但覆盖率不能替代 V01–V14 的行为断言。
- 原型报告必须逐项 PASS；缺失 renderer 或 dependency export 导致 BLOCKED 时，禁止进入业务集成。
- 集成报告单列 synthetic、real-renderer、real-session-copy 三种证据，不能把前两者写成真实现场已修好。准确现场未提供则保留“现场验收未完成”。

## 现场安全与复用证明
现场只读采样/复制到隔离工作目录；测试不能使用原会话作为写入对象。提交的 fixtures 为脱敏最小复现，截图/正文不自动纳入制品。
通用日志消费者不得 import assistant/tool/provider/Conversation；Eidolon 卡片仍由宿主提供。这证明核心不依赖 AI 语义，但不宣称已经验证浏览器等其他 renderer。
最终交付包括原型启动命令、自动化命令、公共 API 示例、依赖边界检查及故障 trace 读取说明。
