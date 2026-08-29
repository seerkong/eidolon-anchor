# 官方 DeepSeek 三模式矩阵

## 结论

标准矩阵包含 18 个真实运行单元：六个冻结的 Codument 命题，分别以普通模式、AI Ctrl Workflow 和 AI Data Workflow 运行。18 个进程全部完成，所有独立命题验证器均通过；标准样本共发起 2,678 次官方 DeepSeek 调用，Provider failure 和 retry 均为零。

普通模式单元没有 Workflow 身份。Ctrl 单元公开 `AICtrlWorkflow`，Data 单元公开 `AIDataWorkflow`。所有身份都来自 `terminal.runtime.public-events/v1`，其中包含精确的 definition、instance、run 和 node actor 标识符。

## 汇总对比

原始比率是计费比率 `hit / (hit + miss)`。保留前缀覆盖率只在每个连续 Provider scope 内重新计算，公式为 `min(当前 cache hit, 上一次 prompt) / 上一次 prompt`；冷启动轮次、新增输入以及跨 session/epoch 的相邻关系不计入其中。

| 模式 | 通过 | 调用次数 | 失败 / 重试 | Prompt tokens | Output tokens | 原始计费命中率 | 加权保留前缀覆盖率 | 最差可比 scope | 前缀完整性 | 归一化输入成本 | 总耗时 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 普通模式 | 6/6 | 794 | 0 / 0 | 68,478,423 | 659,380 | 95.5424% | 99.9967% | 99.9784% | 1.0 | 9,595,095.0 | 115m 56.1s |
| AI Ctrl | 6/6 | 1,018 | 0 / 0 | 73,665,301 | 685,924 | 95.8159% | 99.9958% | 99.9088% | 1.0 | 10,140,565.0 | 153m 31.6s |
| AI Data | 6/6 | 866 | 0 / 0 | 57,748,096 | 590,401 | 93.2995% | 99.9964% | 99.8927% | 1.0 | 9,257,305.6 | 136m 22.6s |

与普通模式相比，Ctrl 的汇总归一化输入成本高 5.68%，Data 则低 3.52%。Ctrl 的调用次数多 28.21%，Data 多 9.07%；两者的总耗时分别多 32.43% 和 17.63%。这说明执行轨迹存在差异，并不表示 Workflow 会系统性损害缓存：在部分命题中，Workflow 模式调用次数更多；在另一些命题中，其 Prompt token 更少或原始缓存覆盖率更高。

## 各命题的归一化输入成本

| 命题 | 普通模式 | AI Ctrl | Ctrl 相比普通模式 | AI Data | Data 相比普通模式 |
|---|---:|---:|---:|---:|---:|
| stream-pipeline | 1,257,691.0 | 1,500,515.4 | +19.31% | 737,048.6 | -41.40% |
| modeling-todo | 1,372,658.6 | 2,178,847.6 | +58.73% | 1,040,500.0 | -24.20% |
| modeling-blog | 1,248,881.6 | 2,224,631.4 | +78.13% | 1,875,702.0 | +50.19% |
| modeling-ecommerce-core | 1,987,280.6 | 1,639,048.0 | -17.52% | 2,370,897.6 | +19.30% |
| modeling-ecommerce-payment | 1,609,444.0 | 1,057,145.0 | -34.32% | 2,276,872.2 | +41.47% |
| nested-mission-agent | 2,119,139.2 | 1,540,377.6 | -27.31% | 956,285.2 | -54.87% |

不同命题之间成本增减方向相反，之前重复执行的 stream sentinel 也呈现同样现象。这说明，自主实现时做出的具体选择主导了单个运行单元的成本。当前证据支持的结论是：现有 Workflow Provider surface 能够保持前缀缓存，并且不会在整个命题集层面引入成本上涨；这些证据并不表示任何一种 Workflow 形式在所有场景下都会更便宜。

## 正确性与稳定性证据

| 命题 | 普通模式 | AI Ctrl | AI Data |
|---|---|---|---|
| stream-pipeline | 通过，无 Workflow | 通过，`AICtrlWorkflow` | 通过，`AIDataWorkflow` |
| modeling-todo | 通过，无 Workflow | 通过，`AICtrlWorkflow` | 通过，`AIDataWorkflow` |
| modeling-blog | 通过，无 Workflow | 通过，`AICtrlWorkflow` | 通过，`AIDataWorkflow` |
| modeling-ecommerce-core | 通过，无 Workflow | 通过，`AICtrlWorkflow` | 通过，`AIDataWorkflow` |
| modeling-ecommerce-payment | 通过，无 Workflow | 通过，`AICtrlWorkflow` | 通过，`AIDataWorkflow` |
| nested-mission-agent | 通过，无 Workflow | 通过，`AICtrlWorkflow` | 通过，`AIDataWorkflow` |

标准运行单元中没有出现 `invalid_provider_request_body`、无法解释的 5xx 重试循环、不可恢复的会话续接失败、模式身份不匹配或保留前缀偏离。ecommerce-core Data r1 的观测中出现了一次瞬时网络失败和一次重试，因此没有被采纳为最终证据；它已由干净的 r2 运行替代，后者包含 180 次调用，失败和重试均为零。一次失败的普通模式 blog 尝试同样未被纳入标准矩阵。

nested-Mission 验证器在所有模式下都验收通过，覆盖了两个独立仓库、互为关联的 Mission 层级、所选任务的完成语义、可移植的 workspace binding、跨层 Track link、可运行服务以及严格校验。

## 缓存指标解读

全部 127 个可比 Provider scope 都至少保留了其紧邻上一次有效前缀的 99.8927%，每种模式的加权覆盖率均约为 99.996%。这达到了已确认的 99.5% 历史目标。

原始计费命中率较低，是因为它包含首次使用的新输入以及冷启动/压缩 epoch。不能将它直接与历史长时间运行场景中约 `99.5%` 的保留前缀观测值比较。当原始比率较低，但完整性为 1.0、保留前缀覆盖率接近完美时，表示上下文有所增长，并不表示之前的稳定前缀被替换。

对于 stream r2 receipts，汇总前缀诊断是在跨 session/epoch 相邻关系分类器修复之前生成的。其各 scope 事实具有权威性，本报告已据此重新计算。Modeling 和 nested-Mission receipts 使用的是修复后的汇总分类器。

## 来源追踪与收敛动作

13 个标准运行单元使用已安装 Eidolon 的 digest：`sha256:b9bab4d34acf6d45df0125184284fae02f52676ccd7aada05c405b312e82c4e0`。较早的五个 modeling 单元使用前一版本 digest：`sha256:3538a7cf3c63fc7761d8589a7479a973412e8a35517701a83ddc223ea2b99f03`，分别是四个普通模式 modeling 单元和 Todo Ctrl。两版之间的修复仅涉及失败 Workflow 的公开证据以及 admission 时机的身份记录。

G7 使用 `b9bab4...` 在三种模式下重新运行了 stream 命题。当前二进制 sentinel 的三个外部验证器全部通过，并具备精确的模式身份：共 297 次调用，失败和重试均为零，前缀完整性为 1.0；普通模式、Ctrl 和 Data 的保留前缀覆盖率分别为 99.9970%、99.9970% 和 99.9989%。这在无需花费额度重复执行未受影响命题/模式单元的前提下，关闭了后续代码差异对成功路径造成的来源追踪风险。除非新的独立验证发现 P0/P1 偏差，否则没有理由创建新的产品修复 Track。

## 标准 receipt digest

| 命题 | 普通模式 | AI Ctrl | AI Data |
|---|---|---|---|
| stream-pipeline | `9acfcdad...49b2` | `cf993d2e...a2fb` | `bd4e04dc...ed0f` |
| modeling-todo | `13a672c7...03c1` | `62524257...5c4a` | `c1640bb7...7540` |
| modeling-blog | `f02736f4...e993` | `a2eba817...20a5a1` | `e5f446af...9d3` |
| modeling-ecommerce-core | `ff960531...c0b2` | `83760555...86ffa` | `4e17904c...5614` |
| modeling-ecommerce-payment | `722479e4...92f7` | `29090b20...add7c` | `27bf6470...b4a0` |
| nested-mission-agent | `8f9d99f0...ae63` | `10da3eab...d61a7` | `d9226cf1...71ef6` |
