# 设计：import cutover phase3 shim retirement

## 1. 目标

phase3 的目标非常直接：

- 删除 legacy shim package 目录
- 更新 focused guard
- 证明删除 shim 后运行路径不受影响

## 2. 为什么现在可以删

基于前两轮结果：

- 仓内已无 direct import 消费旧包名
- workspace `tsconfig` 已无 legacy alias
- 旧命名只剩 shim package 自身和 migration guard 文本

因此删除 shim 已不再是行为风险，而是结构收尾。

## 3. 迁移策略

### 3.1 直接退休 shim 包

不再保留“兼容包也继续在 workspace 里存在”的中间状态，因为：

- 对仓内开发已无价值
- 会继续制造误导
- 与当前“新宿主为唯一 truth host”的目标不一致

### 3.2 focused guard 改为检查目录不存在

guard 需要从“shim 是薄 re-export”升级为：

- legacy shim package 目录不存在
- 普通源码与 tsconfig 不得回流旧命名

## 4. 成功标准

- 三个 legacy shim package 目录删除
- migration surface tests 通过
- runtime/profile/tui focused tests 通过
- `codument validate --strict` 通过
