import { Stream, type Listener } from "xstream";

import type {
  BoundedTimeline as BoundedTimelineContract,
  BoundedTimelineOptions,
} from "@cell/symbiont-contract/stream/BoundedTimeline";
import type {
  TimelineChannel,
  TimelineEntry,
  TimelineStreamOptions,
} from "depa-data-graph-core";

export {
  LIVE_EVENT_REPLAY_LIMIT,
  OBSERVABILITY_TRACE_REPLAY_LIMIT,
} from "@cell/symbiont-contract/stream/BoundedTimeline";
export type { BoundedTimelineOptions } from "@cell/symbiont-contract/stream/BoundedTimeline";

type EntryListener<T> = (entry: TimelineEntry<T>) => void;

function normalizeRetentionLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error("retentionLimit must be a non-negative safe integer");
  }
  return limit;
}

function createReplayableStream<T>(params: {
  entries: () => readonly T[];
  addListener: (listener: (value: T) => void) => () => void;
  disposed: () => boolean;
  options?: TimelineStreamOptions;
}): Stream<T> {
  let unsubscribe: (() => void) | null = null;
  return Stream.create<T>({
    start: (listener: Listener<T>) => {
      unsubscribe?.();
      unsubscribe = null;
      if (params.options?.replay ?? true) {
        for (const value of params.entries()) {
          listener.next(value);
        }
      }
      if (params.disposed()) {
        listener.complete();
        return;
      }
      unsubscribe = params.addListener((value) => listener.next(value));
    },
    stop: () => {
      unsubscribe?.();
      unsubscribe = null;
    },
  });
}

class RetainedWindow<T> {
  private values: Array<T | undefined> = [];
  private start = 0;
  private count = 0;

  constructor(private readonly limit: number) {}

  push(value: T): void {
    if (this.limit === 0) return;
    if (this.count < this.limit) {
      this.values[(this.start + this.count) % this.limit] = value;
      this.count += 1;
      return;
    }
    this.values[this.start] = value;
    this.start = (this.start + 1) % this.limit;
  }

  entries(): readonly T[] {
    const entries: T[] = [];
    for (let index = 0; index < this.count; index += 1) {
      entries.push(this.values[(this.start + index) % this.limit]!);
    }
    return entries;
  }

  size(): number {
    return this.count;
  }

  clear(): void {
    this.values = [];
    this.start = 0;
    this.count = 0;
  }
}

class BoundedTimelineChannel<T> implements TimelineChannel<T> {
  private readonly retained: RetainedWindow<TimelineEntry<T>>;
  private readonly listeners = new Set<EntryListener<T>>();
  private disposed = false;

  constructor(
    readonly id: string,
    retentionLimit: number,
    private readonly appendToParent: (value: T, channel: string) => TimelineEntry<T>,
    private readonly removeFromParent: (id: string) => void,
  ) {
    this.retained = new RetainedWindow(retentionLimit);
  }

  append(value: T): TimelineEntry<T> {
    if (this.disposed) throw new Error(`Timeline channel '${this.id}' is disposed`);
    return this.appendToParent(value, this.id);
  }

  entries(): readonly TimelineEntry<T>[] {
    return this.retained.entries();
  }

  stream(options?: TimelineStreamOptions): Stream<TimelineEntry<T>> {
    return createReplayableStream({
      entries: () => this.entries(),
      addListener: (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      disposed: () => this.disposed,
      options,
    });
  }

  push(entry: TimelineEntry<T>): void {
    if (this.disposed) return;
    this.retained.push(entry);
    for (const listener of this.listeners) listener(entry);
  }

  close(): void {
    this.disposed = true;
    this.retained.clear();
    this.listeners.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.close();
    this.removeFromParent(this.id);
  }
}

export class BoundedTimeline<T> implements BoundedTimelineContract<T> {
  private readonly retained: RetainedWindow<TimelineEntry<T>>;
  private readonly listeners = new Set<EntryListener<T>>();
  private readonly channels = new Map<string, BoundedTimelineChannel<T>>();
  private readonly retentionLimit: number;
  private disposed = false;
  private nextSeq = 1;

  constructor(options: BoundedTimelineOptions) {
    this.retentionLimit = normalizeRetentionLimit(options.retentionLimit);
    this.retained = new RetainedWindow(this.retentionLimit);
  }

  append(value: T, options: { channel?: string } = {}): TimelineEntry<T> {
    if (this.disposed) throw new Error("BoundedTimeline is disposed");
    const entry: TimelineEntry<T> = {
      seq: this.nextSeq,
      at: Date.now(),
      value,
      channel: options.channel,
    };
    this.nextSeq += 1;
    this.retained.push(entry);
    for (const listener of this.listeners) listener(entry);
    if (options.channel) this.channels.get(options.channel)?.push(entry);
    return entry;
  }

  entries(): readonly TimelineEntry<T>[] {
    return this.retained.entries();
  }

  size(): number {
    return this.retained.size();
  }

  stream(options?: TimelineStreamOptions): Stream<TimelineEntry<T>> {
    return createReplayableStream({
      entries: () => this.entries(),
      addListener: (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      disposed: () => this.disposed,
      options,
    });
  }

  createChannel(id: string): TimelineChannel<T> {
    if (this.disposed) throw new Error("BoundedTimeline is disposed");
    if (this.channels.has(id)) throw new Error(`Duplicate timeline channel id: ${id}`);
    const channel = new BoundedTimelineChannel<T>(
      id,
      this.retentionLimit,
      (value, channelId) => this.append(value, { channel: channelId }),
      (channelId) => this.channels.delete(channelId),
    );
    this.channels.set(id, channel);
    return channel;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.retained.clear();
    this.listeners.clear();
    for (const channel of this.channels.values()) channel.close();
    this.channels.clear();
  }
}

export class BoundedEventLog<T> extends BoundedTimeline<T> {}
