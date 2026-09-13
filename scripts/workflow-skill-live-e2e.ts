import { createHash } from "node:crypto"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startWorkflowProviderRelay, type WorkflowProviderBudgetLimits } from "./workflow-e2e-provider-budget"

const providerId = "deepseek-iqingwa"
const modelId = "deepseek-v4-pro"
const modelRef = `${providerId}/${modelId}`
export const liveLimits: WorkflowProviderBudgetLimits = {
  maxRequests: 96, maxOutputTokensPerRequest: 16_384, maxTotalOutputTokens: 196_608,
  timeoutMs: 45 * 60_000, requestTimeoutMs: 180_000,
}
const authorization = `当前隔离测试工作区内的创建、修改、验证、发布资源包及创建实例和执行均已授权。先用正式 Skill 工具加载已安装的 sys-eidolon-anchor-run、sys-eidolon-anchor-authoring、sys-eidolon-anchor-devops 和 sys-halfcode-resource-dsl 的相关知识；专用 actor 也必须自行按阶段读取。通过 WorkflowFulfill 网关交给专用 actor，再通过公开 authoring/publication/run 工具操作。不要用 shell 或直接写磁盘绕过工具，不要复制或猜测标准 Kind 指纹，应获取已安装契约。输出只能根据实际回执。禁止读取密钥、provider 配置或无关文件。保持 ${modelRef}，无模型回退、无传输自动重试。父 actor 只负责 Skill 加载与 WorkflowFulfill 派单，不做磁盘探测。若网关失败，应保留回执并正常结束；不要原样再次派单或使用 shell 诊断，外部验收器会处理失败。`
export const scenarioPrompts = {
  data: `${authorization}\n创建并实际运行 AI Data Workflow，资源名称使用 LiveOrderData。输入为订单 order-314，items=[{sku:"tea",quantity:3,unitPriceCents:425},{sku:"cup",quantity:2,unitPriceCents:1199}]，shippingCents=275。必须用可复用的代码任务计算每行 subtotalCents、itemsSubtotalCents 和 totalCents，保留订单号和原始行；不得硬编码计算结果或用模型口算代替执行。完成发布、创建实例并运行后，报告 resourceRef、session/revision、proof、publication receipt、instance/run id、真实输出和终态，然后正常结束。`,
  ctrl: `${authorization}\n创建并实际执行 AICtrlWorkflow LiveOrderCtrl，通过当前宿主支持的普通 Run + runtime.ai.effects.runAgent 调用一个真实 AIAgentDefinition（使用 form=ai-ctrl 的 WorkflowFulfill 网关）。先读 operations/ai-workflow.md 和 operations/agent-definition.md，按其确切 MaterialBinding 和契约编写。输入订单 order-315，items=[{sku:"tea",quantity:2,unitPriceCents:425}]，shippingCents=100。Ctrl 先用可复用代码计算每行 subtotalCents、itemsSubtotalCents、totalCents，再把真实计算结果传给 Agent 审核，Agent 返回同一 orderId、totalCents 和 approved=true；Ctrl 最终输出需保留计算结果及 Agent 结果、调用身份。必须真实发出 Agent provider 请求；不得由父 actor 代算或伪造 Agent 结果。此轮只完成 Ctrl 创建发布运行，不修改已发布的 LiveOrderData。不要请求尚未接通的 Ctrl-to-Data 调用。完成后报告实际 publication、instance/run、Agent receipt 和输出，并正常结束。`,
  edit: `${authorization}\n通过 WorkflowFulfill(form=ai-data, operation=edit, workflow_ref=resource://local.workflow.LiveOrderData) 编辑已发布的 LiveOrderData，升级 V2：增加输入 discountCents（默认0），totalCents=itemsSubtotalCents+shippingCents-discountCents，输出保留原始行、订单号、小计、总额，并返回 discountCents。保留 V1 实例及其冻结资源。发布 V2 后创建新实例，实际执行 order-314，items=[{sku:"tea",quantity:3,unitPriceCents:425},{sku:"cup",quantity:2,unitPriceCents:1199}]，shippingCents=275，discountCents=50。报告 V2 发布回执、冻结 definition revision、instance/run 和真实输出。此次只编辑并运行这一个 Data 工作流；既有 V1 冻结与历史输出将由独立新进程回读验证，不要求你修改旧实例或重建历史。正常结束。`,
  assignments: `当前隔离测试工作区已有文件组织 holon-product 与 member-worker。先用 Skill 读取 sys-eidolon-anchor-run/SKILL.md 与 operations/holon-member-task.md，然后依次通过 HolonAssign(final) 和 MemberAssign(final) 派单，两个路由都必须真实调用。交给成员的任务是：通过自己的 Skill 工具加载相关已安装 system skill，再计算 order-314：tea 3件每件425分，cup 2件每件1199分，运费275分，返回各行小计和总额及技能读取证据。不需要创建工作流。派单 content 必须明确告诉 Worker：最终整条 assistant 消息仅返回符合其 OutputSchema 的 JSON 对象 {"value":"计算及技能读取证据"}，无 Markdown 围栏或前后说明。不要由父 actor 代算；不使用 shell，不创建临时组织替代文件组织。返回实际任务身份、终态、结果，最后正常结束。父 actor 只做 Skill 读取、正式派单和必要的 HolonTaskObserve，不使用 read/ls 等文件工具探测宿主内部。任何路由返回失败都保留诊断，不原样重复派单；两个路由各尝试一次后正常结束，由外部验收器分析。保持 ${modelRef}。`,
} as const

export async function runWorkflowSkillLiveE2e(args: string[]) {
  const live = args.includes("--live")
  const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
  const scenario = option("--scenario") ?? "data"
  if (!(scenario in scenarioPrompts)) throw new Error("Unknown scenario")
  const promptRepair = args.includes("--repair-prompt")
  const hostRepaired = args.includes("--host-repaired")
  const repair = args.includes("--repair") || hostRepaired || promptRepair
  if (repair && scenario !== "ctrl") throw new Error("--repair is only supported for the Ctrl scenario")
  const taskPrompt = scenarioPrompts[scenario as keyof typeof scenarioPrompts] + (promptRepair
    ? "\n本次修复既有 LiveOrderCtrl 的实际 Prompt 源码。上轮 provider 请求证明 Review Agent 只收到字面量 system/user：当前执行器读取 Prompt.template 属性，忽略嵌套 Content 正文；已安装 Authoring Skill 已纠正此说明。请通过 operation=edit，把真正的审核指令和完整 JSON 输出要求放入两个 Prompt 的 template 属性，不把 role 标签当正文，不依赖 Content 子节点。保持 Agent/输入输出 schema 和实际计算步骤，发布后从本次准确发布回执创建新实例运行。最终必须真实 Agent 返回纯JSON对象、approved=true、order315/950。旧失败实例全部保留。此次预算relay已修正：成功完成的相同请求可属于不同业务调用，但失败或进行中的传输不重发；请不要把已有本地测试relay拒绝描述成iqingwa故障。"
    : hostRepaired
    ? "\n本次复验已发布的 LiveOrderCtrl：上一轮已经修正输入 schema 并发布，但宿主在真正派发 Agent 时错误要求生命周期凭证；宿主现已修复。请保留原资源与失败实例，通过 operation=edit 打开实际包，核对并验证当前输入/输出及调用，必要时修正，再完成发布、创建新实例和实际执行。不要删除 Agent 调用，也不要因为旧实例失败而反复运行旧实例。只有新实例真实调用 Agent 并得到 approved=true、order-315 总额950，才算完成。"
    : repair
    ? "\n本次是针对已发布 LiveOrderCtrl 的修复：保留既有资源和失败实例，按 operation=edit 纠正后发布新版本并创建新实例；不必重新设计整包。上一轮 compute-pricing 已成功返回 order-315 总额950，但 review-order 在 Agent 准备阶段被实际 schema 校验拒绝：AGENT_EXECUTION_SCHEMA_MISMATCH，input.payload must NOT have additional properties。请读取精确 Agent InputSchemaRef 和调用代码，对齐真实 payload 与 schema。不要删除真实 Agent 步骤或放弃结构化输出验收；修复后仍须实际执行并返回 Agent approved=true 和原订单950分结果。"
    : "")
  const repo = path.resolve(import.meta.dir, "..")
  const runRoot = path.resolve(option("--run-root") ?? path.join(repo, "codument/reports", `workflow-skill-live-${Date.now()}`))
  const workspace = path.resolve(option("--workspace") ?? path.join(runRoot, "workspace"))
  const globalRoot = path.join(runRoot, "global")
  const previousManifest = Bun.file(path.join(runRoot, "manifest.json"))
  if (await previousManifest.exists() && (await previousManifest.json()).live) {
    throw new Error("An existing live run must remain immutable; choose a new --run-root")
  }
  const binary = path.resolve(option("--binary") ?? path.join(repo, "dist/terminal/tui/eidolon"))
  const manifest = { schemaVersion: "workflow.skill-live-e2e/v1", scenario, providerId, modelId, codexWorkerModel: "gpt-5.6-terra",
    live, repair, hostRepaired, promptRepair, limits: liveLimits, workspace, globalRoot, binary, binaryDigest: createHash("sha256").update(await readFile(binary)).digest("hex"),
    startedAt: new Date().toISOString(), automaticRetry: false, automaticContinuation: false, status: "prepared" }
  await mkdir(runRoot, { recursive: true })
  await mkdir(path.join(workspace, ".eidolon"), { recursive: true })
  const save = (name: string, value: unknown) => writeFile(path.join(runRoot, name), JSON.stringify(value, null, 2) + "\n")
  if (scenario === "assignments") {
    const { prepareSkillDrivenOrganizationWorkspace } = await import("../cell/packages/ai-organ-logic/tests/workflow/prepareSkillDrivenOrganizationWorkspace")
    await save("organization-fixture.json", await prepareSkillDrivenOrganizationWorkspace(workspace))
  }
  await save("manifest.json", manifest)
  const env = { ...process.env, EIDOLON_GLOBAL_DIR: globalRoot }
  const init = Bun.spawn([binary, "global", "init", "--root", globalRoot, "--json"], { cwd: workspace, env, stdout: "pipe", stderr: "pipe" })
  const [initCode, initOut, initErr] = await Promise.all([init.exited, new Response(init.stdout).text(), new Response(init.stderr).text()])
  await writeFile(path.join(runRoot, "global-init.json"), initOut)
  if (initCode !== 0) throw new Error(`Global initialization failed: ${initErr}`)
  await writeFile(path.join(runRoot, `${scenario}-prompt.txt`), taskPrompt)
  if (!live) { console.log(JSON.stringify({ runRoot, status: "prepared-no-provider-request" })); return }
  const catalog = JSON.parse(await readFile(path.join(os.homedir(), ".eidolon/llm-provider.json"), "utf8"))
  const provider = catalog.providers.find((entry: any) => entry.id === providerId)
  const model = provider?.models.find((entry: any) => entry.id === modelId)
  if (!model || !provider.options?.apiKey || provider.adapter !== "deepseek" || provider.options.baseURL !== "https://ai.iqingwa.com/v1") throw new Error("Exact authorized provider configuration unavailable")
  const relay = startWorkflowProviderRelay({ live, model: modelId, upstreamBaseUrl: provider.options.baseURL, apiKey: provider.options.apiKey, limits: liveLimits })
  const configPath = path.join(workspace, ".eidolon/llm-provider.json")
  // The workspace sees only the local relay token; upstream credentials remain in this process.
  await writeFile(configPath, JSON.stringify({ providers: [{ id: providerId, adapter: "deepseek", options: { baseURL: relay.baseUrl, apiKey: "isolated-relay" },
    models: [{ ...model, limits: { ...model.limits, output: liveLimits.maxOutputTokensPerRequest } }] }] }))
  await chmod(configPath, 0o600)
  const ctrlOrder = scenario === "ctrl"
  await save("oracle-input.json", {
    orderId: ctrlOrder ? "order-315" : "order-314",
    items: ctrlOrder ? [{ sku: "tea", quantity: 2, unitPriceCents: 425 }]
      : [{ sku: "tea", quantity: 3, unitPriceCents: 425 }, { sku: "cup", quantity: 2, unitPriceCents: 1199 }],
    shippingCents: ctrlOrder ? 100 : 275,
    ...(scenario === "edit" ? { discountCents: 50 } : {}),
    expectedSubtotals: ctrlOrder ? [850] : [1275, 2398],
    expectedTotalCents: ctrlOrder ? 950 : scenario === "edit" ? 3898 : 3948,
  })
  await writeFile(path.join(workspace, ".eidolon/agent-present.json"), JSON.stringify({ default_preset: "live", presets: { live: { primary: { model: modelRef } } }, fallback: { enabled: false } }))
  const ledgerTimer = setInterval(() => void save("provider-budget.json", relay.budget.snapshot()), 1000)
  let child: ReturnType<typeof Bun.spawn> | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await save("manifest.json", { ...manifest, status: "running" })
    child = Bun.spawn([binary, "exec", "-", "--cwd", workspace, "--model", modelRef, "--full-auto", "-c", "mcp_servers={}",
      "--capture-provider-requests", "--json", "--timeout", "1200", "--output-last-message", path.join(runRoot, `${scenario}-last-message.txt`),
      "--output-trace", path.join(runRoot, `${scenario}-trace.jsonl`)], { cwd: workspace, env,
      stdin: new Blob([taskPrompt]), stdout: Bun.file(path.join(runRoot, `${scenario}-exec.json`)), stderr: Bun.file(path.join(runRoot, `${scenario}-stderr.log`)) })
    killTimer = setTimeout(() => child?.kill(), 1_230_000)
    const exitCode = await child.exited
    await save("manifest.json", { ...manifest, status: "execution-finished-requires-oracle-review", exitCode, finishedAt: new Date().toISOString() })
    console.log(JSON.stringify({ runRoot, workspace, scenario, exitCode, providerAttempts: relay.budget.snapshot().attempts.length }))
  } finally {
    if (killTimer) clearTimeout(killTimer)
    clearInterval(ledgerTimer)
    relay.close()
    await save("provider-budget.json", relay.budget.snapshot())
  }
}

if (import.meta.main) await runWorkflowSkillLiveE2e(process.argv.slice(2))
