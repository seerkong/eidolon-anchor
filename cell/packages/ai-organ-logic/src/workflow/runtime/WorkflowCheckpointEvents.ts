import { createHash } from 'node:crypto';
import type { FlowRunCheckpointRuntime, AIWorkflowRunEvent } from 'ai-workflow-contract';
import type { WorkflowFactStore } from './WorkflowFactStore';
export type WorkflowCheckpointObserver = (checkpoint: Awaited<ReturnType<FlowRunCheckpointRuntime['checkpointStore']['commit']>>) => Promise<void>;
/** Optional read projection after the original canonical commit; never writes checkpoint state. */
export function createWorkflowCheckpointObserver(facts: WorkflowFactStore): WorkflowCheckpointObserver {
    return async (checkpoint) => {
        const prior = await facts.readRunEvents(checkpoint.runId), seen = new Set(prior.map(event => event.eventId));
        if (prior.length >= 16384)
            throw new Error('workflow_event_capacity');
        const profile = checkpoint.profile as any, state = checkpoint.state as any;
        const generation = profile.kind === 'AIDataWorkflow' ? profile.runGraph.currentGeneration : state.generation ?? 0;
        const run = { workflow: { ref: checkpoint.definition.provenance.artifactRef, scheme: 'resource' as const }, runId: checkpoint.runId, generation };
        const eventId = (value: unknown) => 'checkpoint:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
        const events: AIWorkflowRunEvent[] = [{ eventId: eventId([checkpoint.runId, checkpoint.version]), runId: checkpoint.runId, generation, type: 'workflow.checkpoint.observed', atMs: Date.now(), payload: { authority: 'derived-checkpoint-observation', checkpointVersion: checkpoint.version, instanceId: checkpoint.instanceId, definitionRevision: checkpoint.definition.revision, status: String(checkpoint.controllerSidecars.status ?? state.status ?? 'Unknown') } }];
        const nodes: Array<{
            nodeId: string;
            generation: number;
            status: string;
            invocationKey?: string;
        }> = [];
        if (profile.kind === 'AIDataWorkflow') {
            for (const [nodeId, node] of Object.entries(profile.runGraph.nodes) as Array<[
                string,
                any
            ]>)
                nodes.push({ nodeId, generation: node.generation, status: node.status });
        }
        else if (profile.kind === 'AICtrlWorkflow') {
            const snapshot = profile.snapshot;
            for (const [invocationKey, outcome] of Object.entries(snapshot.nodeResults)) {
                const withoutVisit = invocationKey.slice(0, invocationKey.lastIndexOf('#')), nodeId = withoutVisit.slice(withoutVisit.lastIndexOf('/') + 1);
                nodes.push({ nodeId, generation, status: outcome === 'Success' ? 'Succeeded' : 'Failed', invocationKey });
            }
            for (const handle of snapshot.openWaitHandles)
                nodes.push({ nodeId: handle.nodeKey, generation, status: 'Waiting', invocationKey: handle.invocationKey });
        }
        for (const node of nodes)
            events.push({ eventId: eventId([checkpoint.runId, node]), runId: checkpoint.runId, generation: node.generation, nodeId: node.nodeId, type: 'workflow.node.observed', atMs: events[0]!.atMs, payload: { authority: 'derived-checkpoint-observation', checkpointVersion: checkpoint.version, ...node } });
        for (const event of events)
            if (!seen.has(event.eventId)) {
                await facts.appendRunEvent(run, event);
                seen.add(event.eventId);
            }
    };
}
