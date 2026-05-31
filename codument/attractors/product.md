# eidolon-anchor 产品级 Attractor

*初始化时间: 2026-06-02*

---

## 什么是产品级 Attractor

产品级 Attractor 描述的是产品层面的设计意图，而非具体的技术实现。这些 Attractor 指导产品如何演进，而非代码如何组织。

---

## 核心 Attractor

### Holon 自组织 [holon-self-organization]

**核心描述：** Holon（整体-部分）是自组织的单元，既有自主性又有从属性。多个 holon 可以组成更高层级的整体。

**具体体现：**
- `HolonCreate` 支持 autonomous 和 leader_led 两种治理模式
- Holon 可以动态添加 member，member 可以独立工作
- Holon 内部通过 message 协同，而非中央控制
- Holon 的治理模式可以根据上下文切换

**为什么是 attractor：**
- 自组织系统能够适应动态环境
- 违反此 attractor 的系统僵化于固定拓扑
- Holon 模型提供了灵活的层级组织方式