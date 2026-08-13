import skillMd from "./assets/sys-ai-workflow/SKILL.md" with { type: "text" };
import systemSkillXnl from "./assets/sys-ai-workflow/system-skill.xnl" with { type: "text" };
import planningSystem from "./assets/sys-ai-workflow/planning/system.md" with { type: "text" };
import planningProtocol from "./assets/sys-ai-workflow/planning/protocol.md" with { type: "text" };
import planningScenarios from "./assets/sys-ai-workflow/planning/scenarios/index.md" with { type: "text" };
import codingSystem from "./assets/sys-ai-workflow/coding/system.md" with { type: "text" };
import codingProtocol from "./assets/sys-ai-workflow/coding/protocol.md" with { type: "text" };
import codingKernel from "./assets/sys-ai-workflow/coding/generation-kernel.md" with { type: "text" };
import codingWorkspace from "./assets/sys-ai-workflow/coding/workspace.md" with { type: "text" };
import flowDslReadme from "./assets/sys-ai-workflow/coding/flow-dsl/README.md" with { type: "text" };
import flowDslProvenance from "./assets/sys-ai-workflow/coding/flow-dsl/provenance.xnl" with { type: "text" };
import depaAxioms from "./assets/sys-ai-workflow/coding/flow-dsl/foundation/depa-axioms.md" with { type: "text" };
import syntaxAxioms from "./assets/sys-ai-workflow/coding/flow-dsl/foundation/syntax-axioms.md" with { type: "text" };
import naming from "./assets/sys-ai-workflow/coding/flow-dsl/foundation/naming-axioms.md" with { type: "text" };
import eagerAxioms from "./assets/sys-ai-workflow/coding/flow-dsl/std/eager-data-flow/axioms.md" with { type: "text" };
import workAxioms from "./assets/sys-ai-workflow/coding/flow-dsl/std/work-ctrl-flow/axioms.md" with { type: "text" };
import aiDataAxioms from "./assets/sys-ai-workflow/coding/flow-dsl/std/ai-data-workflow/axioms.md" with { type: "text" };
import aiCtrlAxioms from "./assets/sys-ai-workflow/coding/flow-dsl/std/ai-ctrl-workflow/axioms.md" with { type: "text" };
import coreDomains from "./assets/sys-ai-workflow/coding/flow-dsl/spec/flow-core/domains.md" with { type: "text" };
import coreFiles from "./assets/sys-ai-workflow/coding/flow-dsl/spec/flow-core/files.md" with { type: "text" };
import coreNodes from "./assets/sys-ai-workflow/coding/flow-dsl/spec/flow-core/nodes.md" with { type: "text" };
import coreOrchestration from "./assets/sys-ai-workflow/coding/flow-dsl/spec/flow-core/orchestration.md" with { type: "text" };
import coreRefs from "./assets/sys-ai-workflow/coding/flow-dsl/spec/flow-core/refs.md" with { type: "text" };
import eagerDomains from "./assets/sys-ai-workflow/coding/flow-dsl/spec/eager-data-flow/domains.md" with { type: "text" };
import eagerFiles from "./assets/sys-ai-workflow/coding/flow-dsl/spec/eager-data-flow/files.md" with { type: "text" };
import eagerNodes from "./assets/sys-ai-workflow/coding/flow-dsl/spec/eager-data-flow/nodes.md" with { type: "text" };
import eagerRefs from "./assets/sys-ai-workflow/coding/flow-dsl/spec/eager-data-flow/refs.md" with { type: "text" };
import workDomains from "./assets/sys-ai-workflow/coding/flow-dsl/spec/work-ctrl-flow/domains.md" with { type: "text" };
import workNodes from "./assets/sys-ai-workflow/coding/flow-dsl/spec/work-ctrl-flow/nodes.md" with { type: "text" };
import aiResources from "./assets/sys-ai-workflow/coding/flow-dsl/spec/ai-workflow/resources.md" with { type: "text" };
import aiDataWorkflow from "./assets/sys-ai-workflow/coding/flow-dsl/spec/ai-workflow/data-workflow.md" with { type: "text" };
import aiCtrlWorkflow from "./assets/sys-ai-workflow/coding/flow-dsl/spec/ai-workflow/ctrl-workflow.md" with { type: "text" };
import buildingSystem from "./assets/sys-ai-workflow/building/system.md" with { type: "text" };
import buildingProtocol from "./assets/sys-ai-workflow/building/protocol.md" with { type: "text" };
import testingSystem from "./assets/sys-ai-workflow/testing/system.md" with { type: "text" };
import testingProtocol from "./assets/sys-ai-workflow/testing/protocol.md" with { type: "text" };
import releasingSystem from "./assets/sys-ai-workflow/releasing/system.md" with { type: "text" };
import releasingProtocol from "./assets/sys-ai-workflow/releasing/protocol.md" with { type: "text" };
import deployingSystem from "./assets/sys-ai-workflow/deploying/system.md" with { type: "text" };
import deployingProtocol from "./assets/sys-ai-workflow/deploying/protocol.md" with { type: "text" };
import operatingSystem from "./assets/sys-ai-workflow/operating/system.md" with { type: "text" };
import operatingProtocol from "./assets/sys-ai-workflow/operating/protocol.md" with { type: "text" };
import monitoringSystem from "./assets/sys-ai-workflow/monitoring/system.md" with { type: "text" };
import monitoringProtocol from "./assets/sys-ai-workflow/monitoring/protocol.md" with { type: "text" };

export type BundledSystemSkill = {
  name: string;
  version: string;
  files: Readonly<Record<string, string>>;
};

export const BUNDLED_SYSTEM_SKILLS: readonly BundledSystemSkill[] = [{
  name: "sys-ai-workflow",
  version: "1.0.6",
  files: {
    "SKILL.md": skillMd,
    "system-skill.xnl": systemSkillXnl,
    "planning/system.md": planningSystem,
    "planning/protocol.md": planningProtocol,
    "planning/scenarios/index.md": planningScenarios,
    "coding/system.md": codingSystem,
    "coding/protocol.md": codingProtocol,
    "coding/generation-kernel.md": codingKernel,
    "coding/workspace.md": codingWorkspace,
    "coding/flow-dsl/README.md": flowDslReadme,
    "coding/flow-dsl/provenance.xnl": flowDslProvenance,
    "coding/flow-dsl/foundation/depa-axioms.md": depaAxioms,
    "coding/flow-dsl/foundation/syntax-axioms.md": syntaxAxioms,
    "coding/flow-dsl/foundation/naming-axioms.md": naming,
    "coding/flow-dsl/std/eager-data-flow/axioms.md": eagerAxioms,
    "coding/flow-dsl/std/work-ctrl-flow/axioms.md": workAxioms,
    "coding/flow-dsl/std/ai-data-workflow/axioms.md": aiDataAxioms,
    "coding/flow-dsl/std/ai-ctrl-workflow/axioms.md": aiCtrlAxioms,
    "coding/flow-dsl/spec/flow-core/domains.md": coreDomains,
    "coding/flow-dsl/spec/flow-core/files.md": coreFiles,
    "coding/flow-dsl/spec/flow-core/nodes.md": coreNodes,
    "coding/flow-dsl/spec/flow-core/orchestration.md": coreOrchestration,
    "coding/flow-dsl/spec/flow-core/refs.md": coreRefs,
    "coding/flow-dsl/spec/eager-data-flow/domains.md": eagerDomains,
    "coding/flow-dsl/spec/eager-data-flow/files.md": eagerFiles,
    "coding/flow-dsl/spec/eager-data-flow/nodes.md": eagerNodes,
    "coding/flow-dsl/spec/eager-data-flow/refs.md": eagerRefs,
    "coding/flow-dsl/spec/work-ctrl-flow/domains.md": workDomains,
    "coding/flow-dsl/spec/work-ctrl-flow/nodes.md": workNodes,
    "coding/flow-dsl/spec/ai-workflow/resources.md": aiResources,
    "coding/flow-dsl/spec/ai-workflow/data-workflow.md": aiDataWorkflow,
    "coding/flow-dsl/spec/ai-workflow/ctrl-workflow.md": aiCtrlWorkflow,
    "building/system.md": buildingSystem,
    "building/protocol.md": buildingProtocol,
    "testing/system.md": testingSystem,
    "testing/protocol.md": testingProtocol,
    "releasing/system.md": releasingSystem,
    "releasing/protocol.md": releasingProtocol,
    "deploying/system.md": deployingSystem,
    "deploying/protocol.md": deployingProtocol,
    "operating/system.md": operatingSystem,
    "operating/protocol.md": operatingProtocol,
    "monitoring/system.md": monitoringSystem,
    "monitoring/protocol.md": monitoringProtocol,
  },
}];
