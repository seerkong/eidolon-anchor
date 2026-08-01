# Bash Risk Fallback Design

## 上下文

`evaluateUnsupportedBashSyntax` 目前只做 protected config raw reference check，然后按 exact raw command rule 决策；没有匹配 rule 时默认 ask。真实噪音来自只读诊断命令，尤其是复杂 shell 形态包裹的 `cat`、`sed`、`rg`、`ls`、`python` inspection。

## 方案概览

1. 风险分类
   - high-risk token：`rm`、`mv`、`cp`、`chmod`、`chown`、`sudo`、`curl|sh`、重定向写入、`cat >` 等明显写入/执行下载。
   - low-risk readonly signal：命令的 top-level / raw executable 集合只包含 readonly safe commands 或 Python readonly inspection。
   - unknown：既非明显 readonly，也非明确 dangerous，保持 ask。

2. Python readonly inspection
   - 允许包含 `json`、`os.path`、读文件、打印、遍历 JSON。
   - 拒绝 `open(..., "w")`、`write(`、`subprocess`、`os.system`、`shutil`、`socket`、`requests` 等明显副作用。

3. protected config 优先
   - 现有 `bashRawCommandReferencesProtectedPermissionConfig` 仍在 fallback 前生效。
   - 任何 protected config raw reference 维持拒绝。

## 影响范围与修改点（Impact）

- 只在 parser unsupported fallback 分支增加分类。
- 已能 parse 的命令仍走 segment rules，不受 fallback 影响。

## 决策摘要

- fallback 允许 low-risk 的前提是“明确低风险”，不是“未发现危险”。
- unknown 默认 ask，保留用户控制。

## 风险 / 权衡

- 风险：字符串启发式漏判危险写入。
  - 缓解：使用 denylist + readonly executable allowlist + unknown ask，不对复杂未知命令放行。
- 风险：只读 Python inspection 判断过窄。
  - 缓解：从真实 session 的诊断样本开始覆盖，后续按 evidence 扩展。
