import { WorkflowCommandService } from "./WorkflowCommandService"
import { WorkflowQueryService } from "./WorkflowQueryService"

export class WorkflowComponent {
  readonly queries: WorkflowQueryService
  readonly commands: WorkflowCommandService

  constructor(options?: {
    queries?: WorkflowQueryService
    commands?: WorkflowCommandService
  }) {
    this.queries = options?.queries ?? new WorkflowQueryService()
    this.commands = options?.commands ?? new WorkflowCommandService()
  }
}

export function createWorkflowComponent(): WorkflowComponent {
  return new WorkflowComponent()
}
