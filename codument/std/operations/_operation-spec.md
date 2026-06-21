# Operation 提示词规范：Markdown 为主 + 流程标记块（文本化控制流语言）

codument 的每个操作（operation）提示词放 `codument/std/operations/<op>.md`，**以 Markdown 为主**：标题、prose、列表、表格、good/bad 示例、背景与原理，内嵌 XML/代码用 ```` ```xml ```` 围栏。初始化 / upgrade 时这些模板会落盘到工作区，使提示词自包含。

> 这些是操作的**权威 body**；agent skill 壳只引用 `@/codument/std/operations/<op>.md`。

> **默认就用普通 Markdown 写**——解释、示例、规则、背景最完整、最不易丢。不要把整篇 operation 套进任何骨架。

## 流程标记块 = 文本化的控制流语言

当一段内容是**程序化的执行流程**（不只是分支，而是：串行、并行、条件、循环、跳转、返回、失败、退出等**有控制的流程**）时，在该处嵌入一个**流程标记块**，把它当成一门**给模型读的文本化控制流语言**来写。它另有两个副利：

1. **内嵌文字免转义**：payload 里 `<cdt:GapLoop>`、`<codument-gap-loop-result>`、`&`、`|` 原样写。
2. **内嵌文字顶格显示**：每个构造的正文直接贴在标记行下方，不需缩进。

**判据**：凡是"怎么一步步执行、何时分叉/重复/退出/返回"的**控制流**，用标记块；凡是"是什么、为什么、注意什么、示例"的**说明**，用 Markdown。

## 语法

写在 ```` ```text ```` 围栏里：

```text
@delimiter: --
-- #construct ?label [key="value" …]     ← 开块：分隔符×深度 + 构造 + 配对/标签 marker + 属性
…payload（顶格裸文本：动作正文 / 条件文字，可含 <...>）…
---- #child ?l2                           ← 子块：深一层 = 多一个 -- 单位
…
---- /?l2
-- /?label                                ← 收尾（必须；marker 同开块；深度同开块）
```

- 分隔符单位 `--`；**深度 = 行首 `--` 个数**：根 `--`、每深一层 `+--`（`--` / `----` / `------` / `--------`）。
- 每块必须 `-- /?label` 收尾；收尾深度 = 开块深度。
- `#construct` 后**紧跟 `?label`**（块名 = 配对标识 = 节点 id = 跳转目标），再跟可选 `key="value"`。
- **叶子 payload 全裸文本**：不匹配 `^(--)+[ ]+(#\S+.*|/\?\S+)$` 的行原样保留。
- marker 栈式嵌套；条件/循环谓词是**自然语言**（给 LLM 读，不是编译器），如 `cond="首轮 + 无历史 + NO_GAP"`。

## 控制流构造词汇

| 构造 | 属性 | 含义 |
|---|---|---|
| `#sequence` | — | 串行：子块依次执行 |
| `#parallel` | `limit` | 并行：子块并发（limit 限并发数） |
| `#step` | — | 单个动作（叶子）；payload = 要做的事 |
| `#if` / `#else-if` / `#else` | `cond` | 条件分支（同层相邻） |
| `#switch` / `#case` / `#default` | `on` / `when` | 多路分支 |
| `#loop` | `while` `until` `for` `max` | 循环；内部可 `#break`/`#continue`（带 `if`） |
| `#return` | `value` | 返回（结束当前流程，带值/状态） |
| `#fail` / `#on-fail` | `reason` / `if` | 失败终止 / 失败捕获处理 |
| `#exit` | — | 终止整个流程 |
| `#goto` | `target=<label>` | 跳转到某 marker label（慎用） |
| `#spawn` | `as` `inject` | 生成子代理（codument：fresh-subagent；`inject` 注入 agent 档位，如 codex→gpt-5.5/effort=high） |
| `#call` | `target` | 调用另一 skill / sop 流程 |

> 一律用**完整单词**做构造名（不用 `seq`/`par` 等缩写，便于 AI 理解）。单动作的 `#case`/`#if`/`#step` 可把动作正文直接作为该块 payload；复杂体内再嵌子构造。控制动词（`#return`/`#exit`/`#continue`/`#break`/`#fail`）作为显式子块出现。

## 小例

```text
@delimiter: --
-- #loop ?r max="5 轮"
---- #spawn ?run as=fresh-subagent inject="codex→gpt-5.5 effort=high"
独立上下文跑一轮校验，返回 status
---- /?run
---- #switch ?d on=status
------ #case ?ok when=NO_GAP
-------- #return ?done value=收口
-------- /?done
------ /?ok
------ #case ?fix when=FIX_APPLIED
-------- #continue ?c
已修复，继续下一轮复检
-------- /?c
------ /?fix
------ /?d
-- /?r
```

## 文档约定

- 引用一律指向 `codument/std/...`（自包含）。
- 内嵌真 XML（track.xml 片段、输出契约）用 ```` ```xml ```` 围栏展示即可（围栏本就免转义），不必为此上标记块——标记块只为**控制流**。
- 复杂协议完整规程可放 `std/sop/<name>.md`，skill 内 `#call` / 引用之。

完整示例见 `gap-loop.md`。
