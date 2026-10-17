import {
  AgentCard,
  Task,
  StreamResponse,
  TaskState,
  formatSSEEvent,
  formatSSEErrorEvent,
} from "@a2a-js/sdk";
import {
  JsonRpcTransportHandler,
  ServerCallContext,
  type A2ARequestHandler,
} from "@a2a-js/sdk/server";
import {
  TaskNotFoundError,
  TaskNotCancelableError,
  UnsupportedOperationError,
  RequestMalformedError,
} from "@a2a-js/sdk/errors";
import {
  createA2AAssociations,
  type ParticipantTaskAssociation,
} from "@cell/ai-runtime-host-support";
import {
  parseHostParticipantSendCommand,
  parseHostParticipantBootstrapCommand,
  parseHostParticipantControlCommand,
  parseHostParticipantAttachmentCommand,
  parseHostParticipantArtifactRead,
  type HostRequest,
  type RuntimeHostPort,
  type HostExecutionOutput,
} from "@cell/ai-runtime-host-contract";

export const HOLON_PROFILE = "urn:eidolon:holon-participant:1";
function fields(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k))
  )
    throw new RequestMalformedError("invalid_holon_profile");
  return value as Record<string, unknown>;
}
function identity(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512)
    throw new RequestMalformedError("invalid_identity");
  return value;
}
const terminal = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
  TaskState.TASK_STATE_INPUT_REQUIRED,
  TaskState.TASK_STATE_AUTH_REQUIRED,
]);
const pause = (signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      done();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, 400);
    signal.addEventListener("abort", abort, { once: true });
  });

/** A2A is a projection over original runtime owners. This adapter owns no execution state or IM history. */
export function createParticipantA2A(directory: string) {
  const associations = createA2AAssociations(directory);
  return {
    close: () => associations.close(),
    async handle(
      request: Request,
      host: HostRequest,
      runtime: RuntimeHostPort,
      baseURL: string,
    ): Promise<Response> {
      const path = new URL(request.url).pathname;
      const headers = {
        "Cache-Control": "no-store",
        "A2A-Version": "1.0",
        "A2A-Extensions": HOLON_PROFILE,
      };
      const card = AgentCard.fromJSON({
        name: "Eidolon global Holon participants",
        description:
          "Admitted members and Holons in the local daemon global workspace",
        version: "1",
        supportedInterfaces: [
          {
            url: baseURL + "/a2a",
            protocolBinding: "JSONRPC",
            protocolVersion: "1.0",
          },
        ],
        capabilities: {
          streaming: true,
          pushNotifications: false,
          extensions: [
            {
              uri: HOLON_PROFILE,
              required: true,
              description:
                "Global authority, exact admission, immutable context material, durable outputs and original controls",
              params: {
                methods: [
                  "holon.directory",
                  "holon.open",
                  "holon.receipt",
                  "holon.work",
                  "holon.control",
                  "holon.attachment",
                  "holon.artifact",
                ],
              },
            },
          ],
        },
        securitySchemes: {
          bearer: { httpAuthSecurityScheme: { scheme: "bearer" } },
        },
        securityRequirements: [{ schemes: { bearer: [] } }],
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain", "application/json"],
        skills: [
          {
            id: "holon-participant",
            name: "Execute admitted participant task",
            description: "Original Holon governance owns execution",
            tags: ["holon", "member"],
            inputModes: ["text/plain"],
            outputModes: ["text/plain"],
          },
        ],
      });
      if (path.endsWith("/.well-known/agent-card.json")) {
        if (request.method !== "GET")
          return Response.json(
            { code: "method_not_allowed" },
            { status: 405, headers },
          );
        return Response.json(AgentCard.toJSON(card), { headers });
      }
      if (request.headers.get("A2A-Version") !== "1.0")
        return Response.json(
          { code: "version_not_supported" },
          { status: 400, headers },
        );
      if (
        !request.headers
          .get("A2A-Extensions")
          ?.split(",")
          .map((s) => s.trim())
          .includes(HOLON_PROFILE)
      )
        return Response.json(
          { code: "extension_support_required" },
          { status: 400, headers },
        );
      if (request.method !== "POST")
        return Response.json(
          { code: "method_not_allowed" },
          { status: 405, headers },
        );
      const text = await request.text();
      if (Buffer.byteLength(text) > 512 * 1024)
        return Response.json(
          { code: "request_too_large" },
          { status: 413, headers },
        );
      const native = () => {
        request.signal.throwIfAborted();
        return host;
      };
      const find = (id: string) =>
        associations.task(host.principal.principalId, id) ??
        (() => {
          throw new TaskNotFoundError();
        })();
      const observe = async (
        row: ParticipantTaskAssociation,
        historyLength = 0,
      ) => {
        if (row.admissionRejection)
          return Task.fromJSON({
            id: row.taskId,
            contextId: row.contextId,
            status: { state: "TASK_STATE_REJECTED" },
            history: [],
            artifacts: [],
            metadata: {
              [HOLON_PROFILE]: {
                executionRequestId: row.command.commandId,
                recipient: row.command.recipient,
                deliveryUnknown: false,
                admissionRejection: row.admissionRejection,
              },
            },
          });
        const outputs: HostExecutionOutput[] = [];
        let delivery: unknown;
        let after: number | undefined;
        do {
          const page = await runtime.executionOutputPage!(native(), {
            bindingKey: row.command.bindingKey,
            after,
            limit: 100,
          });
          outputs.push(
            ...page.outputs.filter(
              (o) => o.commandId === row.command.commandId,
            ),
          );
          delivery ??= page.deliveries.find(
            (d) => d.commandId === row.command.commandId,
          );
          after = page.nextAfter;
        } while (after !== undefined);
        const page = await runtime.participantWork!(native(), {
          bindingKey: row.command.bindingKey,
          limit: 100,
        });
        let record = page.work.find(
          (w) => w.commandId === row.command.commandId,
        );
        let cursor = page.nextAfter;
        while (!record && cursor !== undefined) {
          const next = await runtime.participantWork!(native(), {
            bindingKey: row.command.bindingKey,
            after: cursor,
            limit: 100,
          });
          record = next.work.find((w) => w.commandId === row.command.commandId);
          cursor = next.nextAfter;
        }
        const status = record?.status;
        const state =
          status === "Succeeded"
            ? "TASK_STATE_COMPLETED"
            : status === "Failed"
              ? "TASK_STATE_FAILED"
              : status === "Cancelled"
                ? "TASK_STATE_CANCELED"
                : record?.questions.some((q) => q.state === "pending")
                  ? "TASK_STATE_INPUT_REQUIRED"
                  : status === "Running"
                    ? "TASK_STATE_WORKING"
                    : "TASK_STATE_SUBMITTED";
        return Task.fromJSON({
          id: row.taskId,
          contextId: row.contextId,
          status: { state },
          history: [],
          artifacts: outputs.map((output) => ({
            artifactId: output.outputId,
            name: output.kind,
            parts: [{ text: output.text }],
            metadata: { [HOLON_PROFILE]: { output } },
            extensions: [HOLON_PROFILE],
          })),
          metadata: {
            [HOLON_PROFILE]: {
              executionRequestId: row.command.commandId,
              recipient: row.command.recipient,
              source: record?.task,
              work: record,
              settings: page.settings,
              delivery,
              deliveryUnknown: !record || status === "SubmissionUnknown",
            },
          },
        });
      };
      const send = async (
        params: Parameters<A2ARequestHandler["sendMessage"]>[0],
      ) => {
        if (params.tenant)
          throw new RequestMalformedError("tenant_not_supported");
        const message = params.message;
        if (!message || message.role !== 1)
          throw new RequestMalformedError("user_message_required");
        const profile = fields(
          message.metadata?.[HOLON_PROFILE],
          message.taskId ? ["control"] : ["submission"],
        );
        if (message.parts.some((p) => p.content?.$case !== "text"))
          throw new RequestMalformedError("text_parts_required");
        if (params.configuration?.taskPushNotificationConfig)
          throw new UnsupportedOperationError(
            "push_notifications_not_supported",
          );
        if (message.taskId) {
          const row = find(message.taskId);
          if (message.contextId && message.contextId !== row.contextId)
            throw new RequestMalformedError("context_mismatch");
          const control = parseHostParticipantControlCommand(profile?.control);
          if (
            control.kind !== "answer" ||
            control.bindingKey !== row.command.bindingKey ||
            control.commandId !== row.command.commandId
          )
            throw new RequestMalformedError("exact_question_control_required");
          await runtime.controlParticipant!(native(), control);
          return observe(row);
        }
        const command = parseHostParticipantSendCommand(profile?.submission);
        const body = message.parts
          .map((part) =>
            part.content?.$case === "text" ? part.content.value : "",
          )
          .join("\n");
        if (body !== command.text)
          throw new RequestMalformedError("text_material_mismatch");
        const contextId = associations.context(
          host.principal.principalId,
          command.bindingKey,
        );
        if (message.contextId && message.contextId !== contextId)
          throw new RequestMalformedError("context_mismatch");
        let row = associations.accept(host.principal.principalId, command);
        if (row.admissionRejection) return observe(row);
        try {
          await runtime.submitExecution!(native(), command);
        } catch (error) {
          const failure = error as {
            status?: number;
            error?: { code?: string };
          };
          if (
            failure.status &&
            failure.status >= 400 &&
            failure.status < 500 &&
            failure.error?.code
          ) {
            row = associations.rejectAdmission(row, failure.error.code);
            return observe(row);
          }
          throw error;
        }
        let task = await observe(row, params.configuration?.historyLength);
        if (!params.configuration?.returnImmediately)
          while (!terminal.has(task.status!.state)) {
            await pause(request.signal);
            task = await observe(row, params.configuration?.historyLength);
          }
        return task;
      };
      async function* stream(id: string): AsyncGenerator<StreamResponse> {
        const row = find(id);
        let task = await observe(row);
        yield { payload: { $case: "task", value: task } };
        const seen = new Set(task.artifacts.map((a) => a.artifactId));
        let state = task.status!.state;
        while (!terminal.has(state)) {
          await pause(request.signal);
          task = await observe(row);
          for (const artifact of task.artifacts)
            if (!seen.has(artifact.artifactId)) {
              seen.add(artifact.artifactId);
              yield {
                payload: {
                  $case: "artifactUpdate",
                  value: {
                    taskId: id,
                    contextId: row.contextId,
                    artifact,
                    append: false,
                    lastChunk: true,
                    metadata: undefined,
                  },
                },
              };
            }
          if (task.status!.state !== state) {
            state = task.status!.state;
            yield {
              payload: {
                $case: "statusUpdate",
                value: {
                  taskId: id,
                  contextId: row.contextId,
                  status: task.status!,
                  metadata: task.metadata,
                },
              },
            };
          }
        }
      }
      const unsupported = async () => {
        throw new UnsupportedOperationError();
      };
      const handler: A2ARequestHandler = {
        getAgentCard: async () => card,
        getAuthenticatedExtendedAgentCard: async () => card,
        sendMessage: send,
        async *sendMessageStream(params) {
          const task = await send({
            ...params,
            configuration: {
              ...params.configuration,
              acceptedOutputModes:
                params.configuration?.acceptedOutputModes ?? [],
              returnImmediately: true,
              taskPushNotificationConfig:params.configuration?.taskPushNotificationConfig,
            },
          });
          yield* stream(task.id);
        },
        getTask: async (params) => {
          if (params.tenant)
            throw new RequestMalformedError("tenant_not_supported");
          return observe(find(params.id), params.historyLength);
        },
        async cancelTask(params) {
          if (params.tenant)
            throw new RequestMalformedError("tenant_not_supported");
          const row = find(params.id),
            task = await observe(row),
            work = task.metadata?.[HOLON_PROFILE]?.work;
          if (!work?.canCancel) throw new TaskNotCancelableError();
          await runtime.controlParticipant!(native(), {
            kind: "cancel",
            bindingKey: row.command.bindingKey,
            commandId: row.command.commandId,
            controlId: crypto.randomUUID(),
            expectedRevision: work.revision,
            occurredAt: new Date().toISOString(),
            reason: "A2A client cancellation",
          });
          return observe(row);
        },
        resubscribe: (params) => {
          if (params.tenant)
            throw new RequestMalformedError("tenant_not_supported");
          return stream(params.id);
        },
        async listTasks(params) {
          if (params.tenant)
            throw new RequestMalformedError("tenant_not_supported");
          if (params.statusTimestampAfter)
            throw new UnsupportedOperationError(
              "timestamp_filter_not_supported",
            );
          const size = params.pageSize ?? 50;
          if (!Number.isInteger(size) || size < 1 || size > 100)
            throw new RequestMalformedError("invalid_page_size");
          const filter = JSON.stringify([
            host.principal.principalId,
            params.contextId,
            params.status,
          ]);
          let offset = 0;
          if (params.pageToken) {
            try {
              const token = JSON.parse(
                Buffer.from(params.pageToken, "base64url").toString(),
              );
              if (
                token.filter !== filter ||
                !Number.isSafeInteger(token.offset) ||
                token.offset < 0
              )
                throw Error();
              offset = token.offset;
            } catch {
              throw new RequestMalformedError("invalid_page_token");
            }
          }
          const rows = associations.list(
            host.principal.principalId,
            params.contextId,
            8192,
          );
          const matching: Task[] = [];
          for (const row of rows) {
            const task = await observe(row);
            if (!params.status || task.status?.state === params.status)
              matching.push(task);
          }
          if (offset > matching.length)
            throw new RequestMalformedError("invalid_page_token");
          const tasks = matching
            .slice(offset, offset + size)
            .map((task) =>
              params.includeArtifacts ? task : { ...task, artifacts: [] },
            );
          const nextPageToken =
            offset + size < matching.length
              ? Buffer.from(
                  JSON.stringify({ filter, offset: offset + size }),
                ).toString("base64url")
              : "";
          return {
            tasks,
            nextPageToken,
            pageSize: size,
            totalSize: matching.length,
          };
        },
        createTaskPushNotificationConfig: unsupported,
        getTaskPushNotificationConfig: unsupported,
        listTaskPushNotificationConfigs: unsupported,
        deleteTaskPushNotificationConfig: unsupported,
      };
      const transport = new JsonRpcTransportHandler(handler),
        context = new ServerCallContext({ requestedVersion: "1.0" });
      context.addActivatedExtension(HOLON_PROFILE);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text);
      } catch {
        return Response.json(
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          },
          { headers },
        );
      }
      try {
        if (
          typeof parsed.method === "string" &&
          parsed.method.startsWith("holon.")
        ) {
          if (
            parsed.jsonrpc !== "2.0" ||
            !["string", "number"].includes(typeof parsed.id)
          )
            throw new RequestMalformedError("invalid_jsonrpc_envelope");
          const input = parsed.params as Record<string, unknown>,
            method = parsed.method;
          let result: unknown;
          if (method === "holon.directory") {
            fields(input, []);
            result = await runtime.participantDirectory!(native());
          } else if (method === "holon.open") {
            const binding = await runtime.openParticipant!(
              native(),
              parseHostParticipantBootstrapCommand(input),
            );
            result = {
              ...binding,
              contextId: associations.context(
                host.principal.principalId,
                binding.bindingKey,
              ),
            };
          } else if (method === "holon.receipt") {
            fields(input, ["bindingKey", "executionRequestId"]);
            const row = associations.receipt(
              host.principal.principalId,
              identity(input?.bindingKey),
              identity(input?.executionRequestId),
            );
            result = row ? Task.toJSON(await observe(row)) : null;
          } else if (method === "holon.work") {
            fields(input, ["bindingKey", "after", "limit"]);
            identity(input.bindingKey);
            if (
              (input.after !== undefined &&
                (!Number.isSafeInteger(input.after) ||
                  Number(input.after) < 0)) ||
              (input.limit !== undefined &&
                (!Number.isInteger(input.limit) ||
                  Number(input.limit) < 1 ||
                  Number(input.limit) > 100))
            )
              throw new RequestMalformedError("invalid_work_cursor");
            result = await runtime.participantWork!(
              native(),
              input as Parameters<
                NonNullable<RuntimeHostPort["participantWork"]>
              >[1],
            );
          } else if (method === "holon.control")
            result = await runtime.controlParticipant!(
              native(),
              parseHostParticipantControlCommand(input),
            );
          else if (method === "holon.attachment")
            result = await runtime.participantAttachment!(
              native(),
              parseHostParticipantAttachmentCommand(input),
            );
          else if (method === "holon.artifact")
            result = await runtime.executionArtifact!(
              native(),
              parseHostParticipantArtifactRead(input),
            );
          else throw new UnsupportedOperationError();
          return Response.json(
            { jsonrpc: "2.0", id: parsed.id, result },
            { headers },
          );
        }
        const result = await transport.handle(parsed, context);
        if (Symbol.asyncIterator in result) {
          const iterator = result[Symbol.asyncIterator]();
          return new Response(
            new ReadableStream<Uint8Array>({
              async pull(controller) {
                try {
                  const next = await iterator.next();
                  if (next.done) controller.close();
                  else
                    controller.enqueue(
                      new TextEncoder().encode(formatSSEEvent(next.value)),
                    );
                } catch (error) {
                  controller.enqueue(
                    new TextEncoder().encode(
                      formatSSEErrorEvent({
                        jsonrpc: "2.0",
                        id: parsed.id ?? null,
                        error: JsonRpcTransportHandler.mapToJSONRPCError(error),
                      }),
                    ),
                  );
                  controller.close();
                }
              },
              async cancel() {
                await iterator.return?.();
              },
            }),
            {
              headers: {
                ...headers,
                "Content-Type": "text/event-stream",
                "X-Accel-Buffering": "no",
              },
            },
          );
        }
        return Response.json(result, { headers });
      } catch (error) {
        const mapped = JsonRpcTransportHandler.mapToJSONRPCError(error),
          nativeFailure = error as {
            status?: number;
            error?: { code?: string; state?: string };
          };
        const code = nativeFailure.error?.code;
        return Response.json(
          {
            jsonrpc: "2.0",
            id: parsed.id,
            error: {
              ...mapped,
              ...(typeof code === "string" &&
              /^[A-Za-z][A-Za-z0-9_]{0,95}$/.test(code)
                ? {
                    data: {
                      code,
                      status: nativeFailure.status,
                      state: nativeFailure.error?.state,
                    },
                  }
                : {}),
            },
          },
          { headers },
        );
      }
    },
  };
}
