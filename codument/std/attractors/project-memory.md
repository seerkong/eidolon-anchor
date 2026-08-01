# Project Memory Attractor（std/attractors/project-memory.md）

> 当 `memory` profile（`config/attractor-profiles.xml`）启用时，本文件定义**长期项目记忆**如何提升。它是 `memory/` tier 的吸引子，地位与 `model-driven-docs.md`（docs tier 吸引子）并列。分层与晋升总览见 [knowledge-tiers.md](./knowledge-tiers.md)。

## 目的

项目记忆**不替代** behaviors、docs、源码。它记录**跨 track 应当影响未来工作**的耐久教训。

## 记忆类别

- `lessons`：来自已完成 track 的可复用学习——约束、权衡、应指导未来实现的经验法则。
- `incidents`：重要失败、回归、故障、迁移问题或调查记录，应当可被后来检索。
- `patterns`：被验证的重复做法、协作协议、设计惯用法、校验实践。
- `summaries`：跨多条记忆或一段已完成工作的周期性综合。

## 提升规则

只有当一条记忆**耐久到足以影响未来 track** 时才提升。

Good：

- 记录某迁移策略为何成功/失败。
- 记录一个反复踩的坑及其暴露它的诊断信号。
- 记录多个未来 track 应复用的稳定设计 pattern。
- 证据积累足够后，对一批相关记忆做 summary。

Bad：

- 把普通任务日志拷进记忆。
- 存本应在 behaviors/docs/源码/测试里的事实。
- 建一个所有分支都要改的中心 `index.md`。
- 把未解决的猜测当耐久教训提升。

## 存储形态

按分钟级、track-更新时间排序；**每条记忆目录自包含**，避免全局索引文件（跨分支/贡献者会冲突）：

```text
codument/memory/<category>/YYYY-MM/YYYY-MM-DD-HHmm-slug/
```

## 复发即固化（与 knowledge-tiers 阶梯衔接）

`memory/` 里**同一类问题反复出现**时，不要停在 prose 记忆——按 [knowledge-tiers.md](./knowledge-tiers.md) §5 再向上固化为可复用方法：`std/methods/` 规程 / `std/actions/` / `attractor-profile` check / `action-hook` / validation 守卫（按项目误报容忍度调优）。

## 复查

归档前检查该 track 是否产出耐久的 lessons/incidents/patterns/summaries。**没有就不要造记忆条目。**
