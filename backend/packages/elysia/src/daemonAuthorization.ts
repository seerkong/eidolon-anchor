import type {
  RuntimeHostPort,
  HostAuthorizationEffects,
  HostRequest,
  AuthorizationTarget,
  ActorAction,
  ActorSummary,
  AssociatedTurn,
  QuestionRecord,
  CommandStatus,
  ObservationFrame,
} from "@cell/ai-runtime-host-contract";
import { RequestFailure } from "./runtimeRoutes";
import {globalTaskSpaceCommandAction,HostProtocolFailure} from '@cell/ai-runtime-host-logic'

/** Policy closures stay in the HTTP owner; they must not disappear at IPC serialization. */
export function authorizeDaemonPort(
  port: RuntimeHostPort,
  policy: HostAuthorizationEffects,
): RuntimeHostPort {
  const check = (request: HostRequest, target?: AuthorizationTarget) => {
    if (
      policy.currentGrantsVersion(request.principal.principalId) !==
        request.principal.grantsVersion ||
      (target && !policy.permits(request.principal, target))
    )
      throw new RequestFailure(403, "forbidden");
  };
  const session = (request: HostRequest, sessionId: string) =>
    check(request, { kind: "session", sessionId, action: "open" });
  const actor = (
    request: HostRequest,
    sessionId: string,
    actorId: string,
    action: ActorAction,
  ) => {
    session(request, sessionId);
    check(request, { kind: "actor", sessionId, actorId, action });
  };
  const may = (
    request: HostRequest,
    sessionId: string,
    actorId: string,
    action: ActorAction,
  ) =>
    policy.permits(request.principal, {
      kind: "actor",
      sessionId,
      actorId,
      action,
    });
  const actorView = (
    request: HostRequest,
    sessionId: string,
    value: ActorSummary,
  ) => ({
    ...value,
    allowedActions: value.allowedActions.filter((action) =>
      may(request, sessionId, value.actorId, action),
    ),
  });
  const visible = (
    request: HostRequest,
    sessionId: string,
    value: ActorSummary,
  ) =>
    may(request, sessionId, value.actorId, "observe") ||
    may(request, sessionId, value.actorId, "read_history");
  const commandActor = (value: CommandStatus) =>
    value.associatedTurn?.actorId ??
    (value.result && "actorId" in value.result
      ? value.result.actorId
      : undefined);
  const turnView = (
    request: HostRequest,
    sessionId: string,
    turn: AssociatedTurn,
  ) => ({
    ...turn,
    canCancel:
      turn.canCancel && may(request, sessionId, turn.actorId, "cancel_turn"),
  });
  const questionView = (
    request: HostRequest,
    sessionId: string,
    question: QuestionRecord,
  ): QuestionRecord => {
    const { schema, ...record } = question;
    const allowed = may(
      request,
      sessionId,
      question.actorId,
      "answer_question",
    );
    return {
      ...record,
      canAnswer: question.canAnswer && allowed,
      ...(allowed && schema ? { schema } : {}),
    };
  };
  const commandView = (
    request: HostRequest,
    sessionId: string,
    command: CommandStatus,
  ) => ({
    ...command,
    ...(command.associatedTurn
      ? { associatedTurn: turnView(request, sessionId, command.associatedTurn) }
      : {}),
  });
  const frameView = (
    request: HostRequest,
    sessionId: string,
    frame: ObservationFrame,
  ): ObservationFrame | undefined => {
    if (frame.kind === "snapshot") {
      const payload = frame.payload;
      const commands = payload.commands
        .filter(
          (c) =>
            !commandActor(c) ||
            may(request, sessionId, commandActor(c)!, "read_history"),
        )
        .map((c) => commandView(request, sessionId, c));
      const readable = (actorId: string) =>
        may(request, sessionId, actorId, "read_history");
      const turns = payload.turns
        .filter((turn) => readable(turn.actorId))
        .map((turn) => turnView(request, sessionId, turn));
      const questions = payload.questions
        .filter((question) => readable(question.actorId))
        .map((question) => questionView(request, sessionId, question));
      const commandIds = new Set(commands.map((command) => command.commandId));
      const turnIds = new Set(turns.map((turn) => turn.turnId));
      const questionnaireIds = new Set(
        questions.map((question) => question.questionnaireId),
      );
      return {
        ...frame,
        payload: {
          ...payload,
          actors: payload.actors
            .filter((a) => visible(request, sessionId, a))
            .map((a) => actorView(request, sessionId, a)),
          histories: payload.histories.filter((history) =>
            readable(history.actorId),
          ),
          pendingStreams: payload.pendingStreams.filter((stream) =>
            readable(stream.actorId),
          ),
          commands,
          turns,
          questions,
          callerControls: {
            commandIds: payload.callerControls.commandIds.filter((id) =>
              commandIds.has(id),
            ),
            turnIds: payload.callerControls.turnIds.filter((id) =>
              turnIds.has(id),
            ),
            questionnaireIds: payload.callerControls.questionnaireIds.filter(
              (id) => questionnaireIds.has(id),
            ),
          },
        },
      };
    }
    if (frame.kind === "actor.created" || frame.kind === "actor.updated")
      return visible(request, sessionId, frame.payload)
        ? { ...frame, payload: actorView(request, sessionId, frame.payload) }
        : undefined;
    if (frame.kind === "command.updated")
      return commandActor(frame.payload) &&
        !may(request, sessionId, commandActor(frame.payload)!, "read_history")
        ? undefined
        : { ...frame, payload: commandView(request, sessionId, frame.payload) };
    if (
      "payload" in frame &&
      "actorId" in frame.payload &&
      !may(request, sessionId, frame.payload.actorId, "read_history")
    )
      return undefined;
    if (frame.kind === "turn.updated")
      return { ...frame, payload: turnView(request, sessionId, frame.payload) };
    if (frame.kind === "question.updated")
      return {
        ...frame,
        payload: questionView(request, sessionId, frame.payload),
      };
    return frame;
  };
  const participant = async (
    request: HostRequest,
    bindingKey: string,
    action: ActorAction,
    input: { after?: number; limit?: number } = {},
  ) => {
    check(request);
    const page = await port.participantWork!(request, {
      bindingKey,
      limit: 100,
      ...input,
    });
    session(request, page.sessionId);
    const actors = await port.actors(
      request,
      { sessionId: page.sessionId },
      {},
    );
    const primary = actors.actors.find(
      (value) => value.executionKind === "primary",
    );
    if (!primary)
      throw new RequestFailure(503, "participant_owner_unavailable");
    actor(request, page.sessionId, primary.actorId, action);
    return page;
  };
  return {
    ...port,
    async workflowDefinitions(request){
      const target={kind:'workflows' as const,action:'discover' as const};check(request,target)
      if(!port.workflowDefinitions)throw new RequestFailure(503,'workflow_workbench_unavailable')
      const value=await port.workflowDefinitions(request);check(request,target);return value
    },
    async workflowRuns(request,input){
      const target={kind:'workflows' as const,action:'read' as const};check(request,target)
      if(!port.workflowRuns)throw new RequestFailure(503,'workflow_workbench_unavailable')
      const value=await port.workflowRuns(request,input)
      for(const run of value.runs)check(request,{...target,runId:run.runId})
      check(request,target);return value
    },
    async workflowRun(request,input){
      const target={kind:'workflows' as const,action:'read' as const,runId:input.runId};check(request,target)
      if(!port.workflowRun)throw new RequestFailure(503,'workflow_workbench_unavailable')
      const value=await port.workflowRun(request,input);check(request,target)
      const canResume=policy.permits(request.principal,{kind:'workflows',action:'resume',runId:input.runId})
      return {...value,waits:value.waits.map(wait=>({...wait,canResume:wait.canResume!==false&&!wait.taskTree&&canResume})),dataResumes:value.dataResumes.map(row=>row.canResume&&!canResume?{...row,canResume:false,unavailableReason:'workflow_resume_forbidden'}:row),...(value.taskTrees?{taskTrees:value.taskTrees.map(tree=>({...tree,canResume:tree.canResume&&canResume}))}:{})}
    },
    async workflowEvents(request,input){
      const target={kind:'workflows' as const,action:'read' as const,runId:input.runId};check(request,target)
      if(!port.workflowEvents)throw new RequestFailure(503,'workflow_workbench_unavailable')
      const value=await port.workflowEvents(request,input);check(request,target);return value
    },
    async workflowMaterial(request,input){
      const target={kind:'workflows' as const,action:'read' as const,runId:input.runId};check(request,target)
      if(!port.workflowMaterial)throw new RequestFailure(503,'workflow_workbench_unavailable')
      const value=await port.workflowMaterial(request,input);check(request,target);return value
    },
    async workflowCommandResult(request,input){
      const target={kind:'workflows' as const,action:'read' as const};check(request,target)
      if(!port.workflowCommandResult)throw new RequestFailure(503,'workflow_workbench_unavailable')
      const value=await port.workflowCommandResult(request,input);check(request,target)
      if(value.runId)check(request,{...target,runId:value.runId});return value
    },
    async commandWorkflow(request,input){
      const target:AuthorizationTarget={kind:'workflows',action:input.kind==='start'?'start':'resume',...(input.kind==='start'?{}:{runId:input.runId})};check(request,target)
      if(!port.commandWorkflow)throw new RequestFailure(503,'workflow_workbench_unavailable')
      const value=await port.commandWorkflow(request,input)
      try{check(request,target)}catch{throw new HostProtocolFailure(403,{code:'forbidden',requestId:request.requestId,retryable:false,state:'unknown'})}
      return value
    },
    async globalTaskCreateResult(request,input){
      check(request,{kind:'global-taskspaces',action:'list'})
      const value=await port.globalTaskCreateResult!(request,input)
      check(request,{kind:'global-taskspace',taskSpaceId:value.taskSpaceId,action:'read'});check(request,{kind:'global-taskspaces',action:'list'});return value
    },
    async globalTaskRootPlan(request,input){
      const target={kind:'global-taskspace' as const,taskSpaceId:input.taskSpaceId,action:'read' as const}
      check(request,target);const value=await port.globalTaskRootPlan!(request,input);check(request,target);return value
    },
    async globalTaskDetail(request,input){
      const target={kind:'global-taskspace' as const,taskSpaceId:input.taskSpaceId,action:'read' as const}
      check(request,target);const value=await port.globalTaskDetail!(request,input);check(request,target);return value
    },
    async globalTaskArtifact(request,input){
      const target={kind:'global-taskspace' as const,taskSpaceId:input.taskSpaceId,action:'read' as const}
      check(request,target);const value=await port.globalTaskArtifact!(request,input);check(request,target);return value
    },
    async globalTaskSpaces(request,input){
      check(request,{kind:'global-taskspaces',action:'list'})
      const value=await port.globalTaskSpaces!(request,input)
      for(const space of value.spaces)check(request,{kind:'global-taskspace',taskSpaceId:space.taskSpaceId,action:'read'})
      check(request,{kind:'global-taskspaces',action:'list'});return value
    },
    async globalTaskSpace(request,input){
      check(request,{kind:'global-taskspace',taskSpaceId:input.taskSpaceId,action:'read'})
      const value=await port.globalTaskSpace!(request,input)
      check(request,{kind:'global-taskspace',taskSpaceId:input.taskSpaceId,action:'read'});return value
    },
    async globalTaskSpaceResult(request,input){
      check(request,{kind:'global-taskspace',taskSpaceId:input.taskSpaceId,action:'read'})
      const value=await port.globalTaskSpaceResult!(request,input)
      check(request,{kind:'global-taskspace',taskSpaceId:input.taskSpaceId,action:'read'});return value
    },
    async commandGlobalTaskSpace(request,input){
      const action=globalTaskSpaceCommandAction(input)
      const target:AuthorizationTarget=input.kind==='create'?{kind:'global-taskspaces',action:'create'}:{kind:'global-taskspace',taskSpaceId:input.taskSpaceId,action:action as 'edit'|'execute'|'control'}
      check(request,target);const value=await port.commandGlobalTaskSpace!(request,input)
      try{check(request,target)}catch{throw new HostProtocolFailure(403,{code:'forbidden',requestId:request.requestId,retryable:false,state:'unknown'})}
      return value
    },
    async participantDirectory(request) {
      check(request, { kind: "server", action: "list_sessions" });
      const value = await port.participantDirectory!(request);
      check(request);
      return value;
    },
    async openParticipant(request, input) {
      check(request, { kind: "server", action: "create_session" });
      const value = await port.openParticipant!(request, input);
      session(request, value.sessionId);
      return value;
    },
    async submitExecution(request, input) {
      await participant(request, input.bindingKey, "send_text");
      if (input.attachmentIds || input.attachments)
        await participant(request, input.bindingKey, "upload_attachment");
      return port.submitExecution!(request, input);
    },
    async executionOutputPage(request, input) {
      const context = await participant(
        request,
        input.bindingKey,
        "read_history",
      );
      const page = await port.executionOutputPage!(request, input);
      check(request);
      for (const output of page.outputs)
        if (output.execution)
          actor(
            request,
            context.sessionId,
            output.execution.actorId,
            "read_history",
          );
      return page;
    },
    async participantWork(request, input) {
      const page = await participant(
        request,
        input.bindingKey,
        "observe",
        input,
      );
      check(request);
      const actors = await port.actors(
        request,
        { sessionId: page.sessionId },
        {},
      );
      const primary = actors.actors.find(
        (value) => value.executionKind === "primary",
      )!;
      let settings: typeof page.settings;
      if(page.settings){
        const {attachments,...rest}=page.settings;
        settings={...rest,canSetModel:page.settings.canSetModel&&may(request,page.sessionId,primary.actorId,'set_model'),...(attachments&&may(request,page.sessionId,primary.actorId,'upload_attachment')?{attachments}:{})};
      }
      return {
        ...page,
        work: page.work.map((work) => ({
          ...work,
          canCancel:
            work.canCancel &&
            work.executions.every((e) =>
              may(request, e.sessionId, e.actorId, "cancel_turn"),
            ),
          questions: work.questions.map((q) => {
            const allowed = may(
              request,
              q.execution.sessionId,
              q.execution.actorId,
              "answer_question",
            );
            return {
              ...q,
              canAnswer: q.canAnswer && allowed,
              questions: allowed ? q.questions : [],
            };
          }),
        })),
        ...(settings?{settings}:{}),
      };
    },
    async controlParticipant(request, input) {
      const context = await participant(
        request,
        input.bindingKey,
        input.kind === "set_model"
          ? "set_model"
          : input.kind === "answer"
            ? "answer_question"
            : "cancel_turn",
      );
      const work = context.work.find((w) => w.commandId === input.commandId);
      if (input.kind !== "set_model") {
        if (!work) throw new RequestFailure(404, "participant_work_not_found");
        for (const execution of work.executions)
          actor(
            request,
            context.sessionId,
            execution.actorId,
            input.kind === "answer" ? "answer_question" : "cancel_turn",
          );
      }
      return port.controlParticipant!(request, input);
    },
    async participantAttachment(request, input) {
      await participant(request, input.bindingKey, "upload_attachment");
      return port.participantAttachment!(request, input);
    },
    async executionArtifact(request, input) {
      await participant(request, input.bindingKey, "read_history");
      return port.executionArtifact!(request, input);
    },
    capabilities(request) {
      check(request);
      return port.capabilities(request);
    },
    async sessions(request, input) {
      check(request, { kind: "server", action: "list_sessions" });
      const result = await port.sessions(request, input);
      check(request);
      return {
        ...result,
        sessions: result.sessions
          .filter((s) =>
            policy.permits(request.principal, {
              kind: "session",
              sessionId: s.sessionId,
              action: "open",
            }),
          )
          .map((s) => ({
            ...s,
            allowedActions: s.allowedActions?.filter((action) =>
              policy.permits(request.principal, {
                kind: "session",
                sessionId: s.sessionId,
                action,
              }),
            ),
          })),
      };
    },
    async createSession(request, input) {
      check(request, { kind: "server", action: "create_session" });
      return port.createSession(request, input);
    },
    async actors(request, selector, input) {
      session(request, selector.sessionId);
      const result = await port.actors(request, selector, input);
      check(request);
      return {
        ...result,
        actors: result.actors
          .filter((a) => visible(request, selector.sessionId, a))
          .map((a) => actorView(request, selector.sessionId, a)),
      };
    },
    async command(request, selector, input) {
      session(request, selector.sessionId);
      if (input.kind === "create_actor")
        check(request, {
          kind: "session",
          sessionId: selector.sessionId,
          action: "create_actor",
        });
      else {
        actor(request, selector.sessionId, input.payload.actorId, input.kind);
        actor(
          request,
          selector.sessionId,
          input.payload.actorId,
          "read_history",
        );
      }
      if (input.kind === "fork_conversation")
        check(request, { kind: "server", action: "create_session" });
      return port.command(request, selector, input);
    },
    async commandStatus(request, selector, input) {
      session(request, selector.sessionId);
      const result = await port.commandStatus(request, selector, input);
      check(request);
      const actorId = commandActor(result);
      if (actorId) actor(request, selector.sessionId, actorId, "read_history");
      return commandView(request, selector.sessionId, result);
    },
    async history(request, selector, input) {
      actor(request, selector.sessionId, selector.actorId, "read_history");
      const result = await port.history(request, selector, input);
      check(request);
      return result;
    },
    async content(request, selector, input) {
      actor(request, selector.sessionId, selector.actorId, "read_history");
      const result = await port.content(request, selector, input);
      check(request);
      return result;
    },
    async attachment(request, selector, input) {
      actor(request, selector.sessionId, selector.actorId, "upload_attachment");
      return port.attachment!(request, selector, input);
    },
    async subscribe(request, selector, input) {
      session(request, selector.sessionId);
      for (const id of input.actors) {
        actor(request, selector.sessionId, id, "observe");
        actor(request, selector.sessionId, id, "read_history");
      }
      const subscription = await port.subscribe(request, selector, input);
      return {
        close: subscription.close,
        frames: {
          async *[Symbol.asyncIterator]() {
            try {
              for await (const frame of subscription.frames) {
                check(request);
                for (const id of input.actors) {
                  actor(request, selector.sessionId, id, "observe");
                  actor(request, selector.sessionId, id, "read_history");
                }
                const projected = frameView(request, selector.sessionId, frame);
                if (projected) yield projected;
              }
            } finally {
              subscription.close();
            }
          },
        },
      };
    },
    async statistics(request, selector, input) {
      session(request, selector.sessionId);
      check(request, {
        kind: "session",
        sessionId: selector.sessionId,
        action: "read_statistics",
      });
      return port.statistics!(request, selector, input);
    },
    async sessionMetadata(request, selector) {
      session(request, selector.sessionId);
      return port.sessionMetadata!(request, selector);
    },
    async manageSession(request, selector, input) {
      session(request, selector.sessionId);
      check(request, {
        kind: "session",
        sessionId: selector.sessionId,
        action: input.kind,
      });
      return port.manageSession!(request, selector, input);
    },
    async sessionManagementResult(request, selector, input) {
      session(request, selector.sessionId);
      return port.sessionManagementResult!(request, selector, input);
    },
    async conversationOperations(request, selector, input) {
      session(request, selector.sessionId);
      const result = await port.conversationOperations!(
        request,
        selector,
        input,
      );
      return {
        ...result,
        operations: result.operations.filter((o) =>
          may(request, selector.sessionId, o.actorId, "read_history"),
        ),
      };
    },
    async conversationOperation(request, selector, input) {
      session(request, selector.sessionId);
      const operation = await port.conversationOperation!(request, selector, {
        ...input,
        reconcile: false,
      });
      actor(request, selector.sessionId, operation.actorId, "read_history");
      if (!input.reconcile) return operation;
      actor(
        request,
        selector.sessionId,
        operation.actorId,
        operation.kind === "fork" ? "fork_conversation" : "rewind_conversation",
      );
      if (operation.kind === "fork")
        check(request, { kind: "server", action: "create_session" });
      return port.conversationOperation!(request, selector, input);
    },
  };
}
