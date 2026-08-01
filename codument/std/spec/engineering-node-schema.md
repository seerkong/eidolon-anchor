# engineering 节点 schema 规范（std/spec/engineering-node-schema.md）

> 定义 `codument/engineering/` 里一个长期工程知识节点长什么样：kind、最小表征、id、引用边界。

## 1. 心法

engineering 节点是**可寻址、可验证、可合并的工程知识单元**。它不复制建模真源，不复述 behavior case，只描述实现/维护/排障视角，并用 URI 连接其他真源。

### 1.1 XNL 属性承载约定

engineering 节点的常规属性一律写进 `{}` 属性块：`kind`、`applies_to`、`related`、`scope` 等都属于节点语义属性，不写在 metadata。metadata 仅保留给 XNL/工具链系统级字段，例如 legacy `metadata.id` 兜底或 vfs/vcs/diff/apply/merge 的内部控制字段。现有 validator 会兼容读取历史 metadata 写法，但新建/修订 registry 与 delta 必须使用 `{}`。

## 2. kind 谱系

| kind | 装什么 | 最小必备表征 |
|---|---|---|
| `overview` | 心智模型、组成、边界 | `desc` + `mental-model` |
| `howto` | 可重复维护操作 | `when-to-use` + `steps` + `verification` |
| `rule` | 实现约束/护栏 | `rule` + `rationale` + `enforcement` |
| `example` | worked example | `scenario` + `walkthrough` |
| `reference` | 查表/配置/API/schema 映射 | `scope` + `source-of-truth` + `update-procedure` |
| `troubleshooting` | 故障诊断与修复 | `symptoms` + `diagnosis` + `fix` |
| `runbook` | 运维/发布/恢复手册 | `preconditions` + `steps` + `verification` + `rollback` |
| `code-map` | 代码路径映射 | `scope` + `paths` + `update-procedure` |

可扩展 shell kind 用命名空间形式放在 `{ kind = "..." }` 属性值里，例如 `security:checklist`。XNL 元素标签不要写冒号。

## 3. 表征形式

| 表征 | 装什么 |
|---|---|
| `<desc>` | 一句话说明 |
| `<mental-model>` | overview 的核心心智模型 |
| `<when-to-use>` | howto 适用场景 |
| `<steps>` | 步骤 |
| `<verification>` | 验证方式 |
| `<rollback>` | 回滚 / 恢复 |
| `<rule>` | 规则正文 |
| `<rationale>` | 为什么 |
| `<enforcement>` | 如何执行 / 测试 / lint |
| `<scenario>` | example 场景 |
| `<walkthrough>` | example 过程 |
| `<scope>` | reference/code-map 范围 |
| `<source-of-truth>` | 查表来源 |
| `<update-procedure>` | 如何更新 |
| `<symptoms>` | 故障症状 |
| `<diagnosis>` | 诊断步骤 |
| `<fix>` | 修复方式 |
| `<paths>` | 代码路径列表 |

## 4. id 与 URI

- id：`#<plane>.<category>.<topic>.<name>`，例如 `#backend.howto.orders.add_endpoint`。
- URI：`engineering://backend/howto/orders/add_endpoint`。
- 路径：`codument/engineering/backend/howto/orders.xnl` 或 `orders/index.xnl`。

## 5. 引用

允许引用：

- `engineering://...`：其他工程知识。
- `modeling://...`：结构/领域真源。
- `behavior://...`：可测行为契约。
- `decision://...`：承重决策。

引用值 canonical 写在 `{}` attribute 中；历史 metadata 写法仍兼容读取。解析器按 scheme 自识别。

## 6. 语言约定

- 描述、步骤、规则、排障内容用中文。
- 代码路径、文件名、函数名、接口名、URI、kind、id 保持英文。

## 7. Good / Bad

Good：

```xnl
<rule #runtime.rules.state.no_derived_writeback {
  kind = "rule"
  applies_to = ["modeling://domain/orders/order"]
} [
  <rule ?>派生 projection 不得反写 authoritative fact。</?>
  <rationale ?>避免多个事实源同时写同一业务状态。</?>
  <enforcement ?>review 时检查写路径；测试覆盖 projection 只读。</?>
]>
```

Bad：

- ❌ 把状态机、实体字段、事实源本体写进 engineering（应放 `modeling`）。
- ❌ 把 BDD case 复制进 engineering（应放 `behaviors`）。
- ❌ 节点没有稳定 id。
- ❌ howto 没有 steps / verification。
