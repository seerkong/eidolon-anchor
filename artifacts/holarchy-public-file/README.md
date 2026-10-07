# 共同公共 File 发行证据

这里的四个 tarball 由 `holon-workbench.ts` 公共源码构建，已正式发布，与组织工作台使用的 registry 版本和 bytes 相同。版本、源码摘要、SHA-256/SHA-512 及兼容报告见 `manifest.json`，真实发布回执见 `publication.json`。`candidate-manifest.json` 保留发布前历史。

从仓库根目录恢复安装：

```powershell
bun install --ignore-scripts --registry=https://registry.npmjs.com --frozen-lockfile
```

生成发行 workspace 注册已移除，不需要准备或解包本地 tarball。当前依赖从 registry 安装；本目录只保存发行证据。registry 指定 `.com`，其返回的 tarball 地址使用 `.org`，回执同时保留实际 registry 与 tarball 地址。

本次升级的 File logic/support 为 0.3.1，capsule 为 0.4.1，test-support 为 0.1.1。Eidolon 完整集成验证仍有既有 Halfcode 类型、历史夹具及 Linux Cozo binary 差距；共同版本安装不等于完整集成通过。
