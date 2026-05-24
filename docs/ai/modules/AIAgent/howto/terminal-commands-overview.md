# AIAgent terminal 命令总览

正式命令面只保留四个一级命令：

- `/actor`
- `/member`
- `/collective`
- `/formation`

## 一张表先看差异

| 命令 | 作用 | 典型对象 | 适合场景 |
|------|------|----------|----------|
| `/actor` | 对任意 actor 进行 assign / status / watch / unwatch | member / collective / formation / detached actor | 统一派发、查询状态、持续监听 |
| `/member` | 创建和列出成员，并对成员派发任务 | member | 创建长期协作者、单成员协作 |
| `/collective` | 创建无 leader 的自治组织并派发任务 | collective | 多成员自治协作 |
| `/formation` | 创建有 leader 的组织并任命 leader / 派发任务 | formation | 需要 leader 结构的组织协作 |

## 最常用命令

### `/actor`

```text
/actor assign <target> :: <content>
/actor assign:n <target> :: <content>
/actor assign:s <target> :: <content>
/actor status <target>
/actor watch <target>
/actor unwatch <target>
```

### `/member`

```text
/member create alice @code :: review the API layer
/member list
/member status alice
/member assign alice :: summarize the bug
/member assign:s alice :: investigate and keep reporting progress
```

### `/collective`

```text
/collective create research
/collective add research alice
/collective assign research :: scan the repo
/collective status research
```

### `/formation`

```text
/formation create alpha
/formation add alpha alice
/formation appoint alpha alice
/formation assign alpha :: prepare an implementation plan
/formation status alpha
```

## 推荐记忆方式

- 想“对谁派活 / 看谁状态” → `/actor`
- 想“创建或列出成员” → `/member`
- 想“让无 leader 组织自治推进” → `/collective`
- 想“让有 leader 的组织推进” → `/formation`
