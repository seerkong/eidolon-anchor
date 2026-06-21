# 设计：import cutover phase2 legacy alias cleanup

## 1. 目标

这轮只清理“开发解析层”上的旧命名残余：

- 删除 `tsconfig` 中的 legacy path alias
- 增加 focused guard
- 不动 compatibility shim 的物理包存在性

## 2. 为什么现在做

phase1 之后，仓内已不存在真实旧包 direct import。继续保留旧 alias 的成本大于收益：

- 新代码容易误用旧命名
- 编辑器/TS 解析仍把旧命名展示成一等入口
- 会拖慢后续 shim 删除判断

## 3. 迁移策略

### 3.1 只删除 alias，不删除 shim 包

这保证：

- 源码开发路径被收紧
- 兼容层仍可保留
- 风险远低于直接删包

### 3.2 focused guard 同时覆盖 import 与 tsconfig

guard 需要覆盖两类回流：

- 普通源码重新 import 旧包
- 工作区 `tsconfig` 重新声明旧 alias

## 4. 成功标准

- `cell/terminal/backend/tui` 的 `tsconfig` 不再声明旧 alias
- focused tests 通过
- `codument validate --strict` 通过
