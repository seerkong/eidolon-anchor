import { createHash, randomUUID } from "node:crypto";

import type {
  ConversationSessionRewindCommand,
  ConversationSessionRewindPort,
  ConversationSessionRewindResult,
} from "@cell/ai-organ-contract";
import { ActorRuntime, createCompletionSignalRegistry } from "depa-actor";

type Mailbox = Readonly<{
  rewind: Readonly<{ requestId: string; command: ConversationSessionRewindCommand }>;
}>;

/** Typed mailbox boundary for the Conversation-owned rewind command. */
export class ConversationSessionRewindActor {
  readonly actorId: string;
  private readonly completions = createCompletionSignalRegistry<string, ConversationSessionRewindResult>();
  private readonly mailbox: ActorRuntime<undefined, Mailbox>;

  constructor(
    identity: Readonly<{ sessionId: string; actorKey: string; actorId: string }>,
    private readonly port: ConversationSessionRewindPort,
  ) {
    this.actorId = `conversation-session-rewind-${createHash("sha256")
      .update(JSON.stringify([identity.sessionId, identity.actorKey, identity.actorId]))
      .digest("hex").slice(0, 40)}`;
    this.mailbox = new ActorRuntime(() => undefined);
    this.mailbox.register(this.actorId, {
      initialState: undefined,
      handlers: {
        rewind: async (_self, envelope) => {
          try {
            this.completions.resolve(envelope.payload.requestId, await this.port.rewind(envelope.payload.command));
          } catch (error) {
            this.completions.resolve(envelope.payload.requestId, {
              status: "rejected",
              rejection: {
                code: "REWIND_TRANSACTION_CONFLICT",
                message: error instanceof Error ? error.message : String(error),
              },
            });
          }
        },
      },
    });
  }

  asPort(senderId = "conversation-surface-host"): ConversationSessionRewindPort {
    return {
      rewind: async (command) => {
        const requestId = randomUUID();
        const completion = new Promise<ConversationSessionRewindResult>((resolve) => {
          const unsubscribe = this.completions.subscribe(requestId, (result) => {
            unsubscribe();
            resolve(result);
          });
        });
        this.mailbox.sendFrom(senderId, this.actorId, "rewind", { requestId, command });
        return await completion;
      },
    };
  }
}

export function createConversationSessionRewindActorPort(input: Readonly<{
  identity: Readonly<{ sessionId: string; actorKey: string; actorId: string }>;
  port: ConversationSessionRewindPort;
  senderId?: string;
}>): ConversationSessionRewindPort {
  return new ConversationSessionRewindActor(input.identity, input.port).asPort(input.senderId);
}
