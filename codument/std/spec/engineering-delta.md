# engineering delta 编写规范（std/spec/engineering-delta.md）

> 每个 track 对 engineering 登记表（`codument/engineering/`）的变更，用**目标态节点 + 节点级 3-way 合并**表达。真 VCS 是宿主 git；xnl-vfs 只当临时合并引擎。
>
> 仅当 `codument/config/engineering.xml` 的 engineering profile `enabled` 时启用。

## 形态：目标态节点

track 在下面路径写改动节点的目标态：

```text
tracks/{pending,active}/<id>/engineering_deltas/<plane>/<category>/<topic>.xnl
```

示例：

```xnl
<howto #backend.howto.orders.add_endpoint { kind = "howto" } [
  <desc ?>新增订单接口的标准维护步骤。</?>
  <when-to-use ?>需要新增 backend endpoint 并接入 behavior case 时使用。</?>
  <steps ?>
  1. 先新增 behavior case。
  2. 在 orders module 增加 route handler。
  3. 写集成测试。
  </?>
  <verification ?>运行 backend route test 与 codument validate。</?>
]>
```

## 操作语义

| 操作 | 怎么表达 |
|---|---|
| 新增 / 修改节点 | 在 `engineering_deltas` 写目标态节点，按 `#id` 命中 |
| 删除节点 | delta 显式删除清单或目标态删除语义，archive merge 时移除 |
| 重命名 / 移动文件 | 用宿主 git rename / vfs rename，保持节点 id 稳定 |
| 同文件内重排 | XNL mutation 按 id 命中 |

## base 锚定

- track create 时记录当前 `codument/engineering` 的宿主 git commit id，作为 3-way base。
- archive 时物化 base、当前 registry(ours)、track delta(theirs)，做三方合并。

## 冲突策略

默认保守：

| 情形 | 默认 |
|---|---|
| 不相交节点 | 自动 |
| 同节点不同子部 | 自动 |
| 纯新增 / 纯删除未被动过节点 | 自动 |
| 同节点同子部异内容 | 人工 |
| delete-modify | 人工 |
| add-add 同 id 异内容 | 人工 |

策略可在 `codument/config/engineering.xml` 覆盖：

```xml
<MergePolicy>
  <Conflict type="same-field" resolve="human"/>
  <Conflict type="delete-modify" resolve="human"/>
  <Conflict type="add-add" resolve="human"/>
</MergePolicy>
```

`resolve` 取 `human | ours | theirs | base`。
