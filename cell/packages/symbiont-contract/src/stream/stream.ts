import type { TimelineChannel } from "depa-data-graph-core";
import type { BoundedTimeline } from "./BoundedTimeline";

/**
 * Compatibility facade for the remaining symbiont stream contracts. Timeline
 * ownership is delegated to depa-data-graph-core; callers should not treat
 * this module as a second event-log or projection substrate.
 */

export type StreamEvent = { event: string; data: string };

export interface OutputStreamContract {
  getTimelineFoundation(): BoundedTimeline<StreamEvent>;
  createLocalTimelineChannel(prefix?: string): TimelineChannel<StreamEvent>;
  send(event: string, data: string): Promise<void>;
  onData(listener: (event: StreamEvent) => void): () => void;
  onEnd(listener: () => void): () => void;
  close(): Promise<void>;
  [Symbol.asyncIterator](): AsyncGenerator<StreamEvent>;
}

export interface InputStreamContract {
  feed(message: string): Promise<void>;
  receive(): Promise<string | null>;
  close(): Promise<void>;
}

export type DuplexStream = {
  input: InputStreamContract;
  output: OutputStreamContract;
};
