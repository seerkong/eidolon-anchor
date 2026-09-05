# 收口配置、权限与闭包依赖

## 背景与目标

Conversation/Holon 迁移后，support 的 LocalFileRuntimeConfigLoader 和 LocalFilePermissionConfigStore 仍反向引用 organ 的混合模块，不能宣称 support-organ 环已消除。本 Track 处理这两个真实共享闭包，并用源码/manifest 检查防回退。

## 范围和兼容

共享的配置、provider option、DeepSeek capability、权限解析规则进入既有 ai-core-logic；文件与环境读取进入 ai-support。organ 旧公开入口可暂时转出口到同一 lower 实现，不复制规则，不相对跨包或延迟导入藏环。默认配置优先级、权限判断、恢复安全和模型行为不改变。

不全仓改名，不移植无关 Workflow IO，不消除所有历史全局变量；旧权限 store 配置入口不扩张。无新增包或 npm 发布，不跟踪 bun.lock。manual 提交。

## 验证

原有 model/config/permission tests 与新增纯值、文件边界、cold import 测试；源码导入和转出口/manifest 图的负例测试，安装的 TypeScript 5.9.3 noEmit。Mission 最后仍须完成全矩阵及已登记 B1 修复。
