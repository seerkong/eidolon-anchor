import type { AIDataControlVerifierFact } from "ai-data-workflow-contract"
import type { FlowClosedValue } from "ai-workflow-contract"

import {
  createAIDataAutonomousControlExtensionCodecRegistry,
  createAIDataAutonomousControlState,
  type AIDataAutonomousControlState,
} from "../src/workflow/runtime/AIDataAutonomousControlLoop"
import {
  projectAIDataAutonomousControllerPayload,
  runAIDataAutonomousControlLoop,
  type AIDataAutonomousControllerPort,
  type AIDataAutonomousVerifierPort,
} from "../src/workflow/runtime/AIDataAutonomousControlRunner"
import { AIDataWorkflowRuntimeDriver } from "../src/workflow/runtime/AIDataWorkflowRuntimeDriver"
import { WorkflowDefinitionRepository } from "../src/workflow/runtime/WorkflowDefinitionRepository"
import { WorkflowRuntimeService } from "../src/workflow/runtime/WorkflowRuntimeService"
import { createWorkflowComponent } from "../src/workflow/component/WorkflowComponent"

const verifier: AIDataAutonomousVerifierPort = {
  async verify(): Promise<AIDataControlVerifierFact> {
    throw new Error("type-only verifier")
  },
}

const controller: AIDataAutonomousControllerPort = {
  async decide(): Promise<{ value: FlowClosedValue }> {
    return { value: null }
  },
}

void verifier
void controller
void runAIDataAutonomousControlLoop
void projectAIDataAutonomousControllerPayload
void createAIDataAutonomousControlExtensionCodecRegistry
void createAIDataAutonomousControlState
void createWorkflowComponent
void AIDataWorkflowRuntimeDriver
void WorkflowDefinitionRepository
void WorkflowRuntimeService
void (null as AIDataAutonomousControlState | null)
