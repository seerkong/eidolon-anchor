import { EventEmitter } from "events";

import type { TimelineChannel } from "depa-data-graph-core";
import type {
  InputStreamContract,
  OutputStreamContract,
  StreamEvent,
} from "@cell/symbiont-contract/stream/stream";

import { BoundedTimeline, LIVE_EVENT_REPLAY_LIMIT } from "./BoundedTimeline";

export type { DuplexStream, InputStreamContract, OutputStreamContract, StreamEvent } from "@cell/symbiont-contract/stream/stream";

export class OutputStream implements OutputStreamContract {
  private static nextChannelId = 1;

  private closed = false;
  private readonly timeline: BoundedTimeline<StreamEvent>;
  private readonly localChannel: TimelineChannel<StreamEvent> | null;
  private readonly localListeners = new Set<(event: StreamEvent) => void>();
  private readonly endListeners = new Set<() => void>();
  private readonly unsubscribeFromFoundation: () => void;

  constructor(options?: { timeline?: BoundedTimeline<StreamEvent>; localChannel?: TimelineChannel<StreamEvent> | null }) {
    this.timeline = options?.timeline ?? new BoundedTimeline<StreamEvent>({ retentionLimit: LIVE_EVENT_REPLAY_LIMIT });
    this.localChannel = options?.localChannel ?? null;

    const stream$ = this.localChannel
      ? this.localChannel.stream({ replay: false })
      : this.timeline.stream({ replay: false });

    const foundationSub = stream$.subscribe({
      next: (entry) => {
        for (const listener of Array.from(this.localListeners)) {
          listener(entry.value);
        }
      },
      error: () => {},
      complete: () => {
        this.emitEnd();
      },
    });
    this.unsubscribeFromFoundation = () => foundationSub.unsubscribe();
  }

  protected static allocateChannelId(prefix = "stream"): string {
    const id = OutputStream.nextChannelId;
    OutputStream.nextChannelId += 1;
    return `${prefix}-${id}`;
  }

  getTimelineFoundation(): BoundedTimeline<StreamEvent> {
    return this.timeline;
  }

  createLocalTimelineChannel(prefix = "stream"): TimelineChannel<StreamEvent> {
    return this.timeline.createChannel(OutputStream.allocateChannelId(prefix));
  }

  async send(event: string, data: string): Promise<void> {
    if (this.closed) return;

    const payload = { event, data };
    if (this.localChannel) {
      this.localChannel.append(payload);
      return;
    }

    this.timeline.append(payload);
  }

  onData(listener: (event: StreamEvent) => void): () => void {
    this.localListeners.add(listener);
    return () => this.localListeners.delete(listener);
  }

  onEnd(listener: () => void): () => void {
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeFromFoundation();

    this.localChannel?.dispose();
    if (!this.localChannel) {
      this.timeline.dispose();
    }
    this.emitEnd();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
    const queue: StreamEvent[] = [];
    let ended = false;
    const onData = (event: StreamEvent) => queue.push(event);
    const onEnd = () => {
      ended = true;
    };
    this.localListeners.add(onData);
    this.endListeners.add(onEnd);
    try {
      while (!ended || queue.length) {
        if (queue.length) {
          yield queue.shift()!;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
    } finally {
      this.localListeners.delete(onData);
      this.endListeners.delete(onEnd);
    }
  }

  private emitEnd(): void {
    for (const listener of Array.from(this.endListeners)) {
      listener();
    }
  }
}

export class TeeOutputStream extends OutputStream {
  constructor(timeline: OutputStream) {
    super({
      timeline: timeline.getTimelineFoundation(),
      localChannel: timeline.createLocalTimelineChannel("tee"),
    });
  }
}

export class InputStream implements InputStreamContract {
  private readonly emitter = new EventEmitter();
  private closed = false;

  async feed(message: string): Promise<void> {
    if (this.closed) return;
    this.emitter.emit("data", message);
  }

  async receive(): Promise<string | null> {
    return new Promise((resolve) => {
      this.emitter.once("data", (message) => resolve(message));
      if (this.closed) resolve(null);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.emitter.emit("end");
  }
}
