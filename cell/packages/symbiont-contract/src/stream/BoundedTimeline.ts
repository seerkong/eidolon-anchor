import type {
  TimelineChannel,
  TimelineEntry,
  TimelineStreamOptions,
} from "depa-data-graph-core";
import type { Stream } from "xstream";

export const LIVE_EVENT_REPLAY_LIMIT = 0;
export const OBSERVABILITY_TRACE_REPLAY_LIMIT = 1_000;

export type BoundedTimelineOptions = {
  retentionLimit: number;
};

/**
 * Contract for a live timeline with an explicit replay window. Implementations
 * retain only the configured history while preserving ordered live delivery.
 */
export interface BoundedTimeline<T> {
  append(value: T, options?: { channel?: string }): TimelineEntry<T>;
  entries(): readonly TimelineEntry<T>[];
  size(): number;
  stream(options?: TimelineStreamOptions): Stream<TimelineEntry<T>>;
  createChannel(id: string): TimelineChannel<T>;
  dispose(): void;
}

export interface BoundedEventLog<T> extends BoundedTimeline<T> {}
