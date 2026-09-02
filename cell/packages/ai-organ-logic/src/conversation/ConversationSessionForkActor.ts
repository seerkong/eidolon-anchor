import { createHash, randomUUID } from "node:crypto";

import type {
  ConversationSessionForkCommand,
  ConversationSessionForkPort,
  ConversationSessionForkResult,
  ConversationSessionRepairCommand,
} from "@cell/ai-organ-contract";
import { ActorRuntime, createCompletionSignalRegistry } from "depa-actor";

export type ConversationSessionForkActorIdentity = Readonly<{
  sessionId: string;
  actorKey: string;
  actorId: string;
}>;

type ConversationSessionForkActorMailbox = Readonly<{
  fork: Readonly<{ requestId: string; command: ConversationSessionForkCommand }>;
  repair: Readonly<{ requestId: string; command: ConversationSessionRepairCommand }>;
}>;

/**
 * Mailbox-owned asynchronous entry for the synchronous Conversation fork
 * command port. Surfaces and other Actors never invoke the persistence-backed
 * port directly; they send a typed message to this Conversation Actor and
 * await its correlated completion signal.
 */
export class ConversationSessionForkActor {
  readonly actorId: string;
  private readonly completions = createCompletionSignalRegistry<string, ConversationSessionForkResult>();
  private readonly mailbox: ActorRuntime<undefined, ConversationSessionForkActorMailbox>;

  constructor(
    readonly identity: ConversationSessionForkActorIdentity,
    private readonly port: ConversationSessionForkPort,
  ) {
    this.actorId = `conversation-session-fork-${createHash("sha256")
      .update(JSON.stringify([identity.sessionId, identity.actorKey, identity.actorId]))
      .digest("hex")
      .slice(0, 40)}`;
    this.mailbox = new ActorRuntime(() => undefined);
    this.mailbox.register(this.actorId, {
      initialState: undefined,
      handlers: {
        fork: async (_self, envelope) => {
          await this.resolveCompletion(
            envelope.payload.requestId,
            async () => await this.port.fork(envelope.payload.command),
          );
        },
        repair: async (_self, envelope) => {
          await this.resolveCompletion(
            envelope.payload.requestId,
            async () => await this.port.repair(envelope.payload.command),
          );
        },
      },
    });
  }

  private async resolveCompletion(
    requestId: string,
    action: () => Promise<ConversationSessionForkResult>,
  ): Promise<void> {
    try {
      this.completions.resolve(requestId, await action());
    } catch (error) {
      this.completions.resolve(requestId, {
        status: "rejected",
        rejection: {
          code: "FORK_TRANSACTION_CONFLICT",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  asPort(senderId = "conversation-surface-host"): ConversationSessionForkPort {
    return {
      fork: async (command) => await this.dispatchFork(command, senderId),
      repair: async (command) => await this.dispatchRepair(command, senderId),
    };
  }

  private completion(requestId: string): Promise<ConversationSessionForkResult> {
    return new Promise<ConversationSessionForkResult>((resolve) => {
      const unsubscribe = this.completions.subscribe(requestId, (result) => {
        unsubscribe();
        resolve(result);
      });
    });
  }

  private async dispatchFork(
    command: ConversationSessionForkCommand,
    senderId: string,
  ): Promise<ConversationSessionForkResult> {
    const requestId = randomUUID();
    const completion = this.completion(requestId);
    this.mailbox.sendFrom(senderId, this.actorId, "fork", { requestId, command });
    return await completion;
  }

  private async dispatchRepair(
    command: ConversationSessionRepairCommand,
    senderId: string,
  ): Promise<ConversationSessionForkResult> {
    const requestId = randomUUID();
    const completion = this.completion(requestId);
    this.mailbox.sendFrom(senderId, this.actorId, "repair", { requestId, command });
    return await completion;
  }
}

export function createConversationSessionForkActorPort(input: Readonly<{
  identity: ConversationSessionForkActorIdentity;
  port: ConversationSessionForkPort;
  senderId?: string;
}>): ConversationSessionForkPort {
  return new ConversationSessionForkActor(input.identity, input.port).asPort(input.senderId);
}
