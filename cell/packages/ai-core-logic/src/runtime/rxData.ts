import { AppendOnlyEventLog, DataGraph, watch } from "depa-data-graph-core";

import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";
import type { ObservabilityRecord } from "@cell/ai-core-contract/runtime/Observability";
import type {
  AiAgentVm,
  AiAgentVmControlSignalStreamEvent,
  AiAgentVmDomainRxEvent,
  AiAgentVmPrivateRxData,
  AiAgentVmPublicRxData,
  AiAgentVmReadonlyRxSignal,
  AiAgentVmRxBinding,
  AiAgentVmSchedulerSignalData,
  AiAgentVmRxStream,
  AiAgentVmRxSubscription,
  AiAgentVmTraceSummaryData,
  AiAgentVmUsageData,
  AiAgentVmWritableRxSignal,
  AiAgentVmWritableRxStream,
} from "@cell/ai-core-contract/runtime/AiAgentVm";

const ZERO_USAGE: AiAgentVmUsageData = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  cache_creation_tokens: 0,
  cache_read_tokens: 0,
  is_estimated: false,
};

const EMPTY_TRACE_SUMMARY: AiAgentVmTraceSummaryData = {
  eventCount: 0,
  lastEventAt: null,
};

const EMPTY_SCHEDULER_SIGNAL: AiAgentVmSchedulerSignalData = {
  readyFiberIds: [],
  runningFiberIds: [],
  suspendedFiberIds: [],
  blockedFiberIds: [],
  pendingResumeFiberIds: [],
  interruptedFiberIds: [],
  updatedAt: null,
};

type RxDataRuntime = {
  vm: AiAgentVm;
};

type RxGraphState = {
  graph: DataGraph<RxDataRuntime>;
  semanticLog: AppendOnlyEventLog<SemanticEvent>;
  historyLog: AppendOnlyEventLog<AiAgentVmDomainRxEvent>;
  promptLog: AppendOnlyEventLog<AiAgentVmDomainRxEvent>;
  sessionLog: AppendOnlyEventLog<AiAgentVmDomainRxEvent>;
  observabilityLog: AppendOnlyEventLog<ObservabilityRecord>;
  observabilityErrorLog: AppendOnlyEventLog<ObservabilityRecord>;
  controlSignalLog: AppendOnlyEventLog<AiAgentVmControlSignalStreamEvent>;
};

export type EnsureVmRxDataResult = {
  privateRxData: AiAgentVmPrivateRxData;
  publicRxData: AiAgentVmPublicRxData;
  privateRxBinding: AiAgentVmRxBinding;
  publicRxBinding: AiAgentVmRxBinding;
};

export function ensureVmRxData(vm: AiAgentVm): EnsureVmRxDataResult {
  if (vm.privateRxData && vm.publicRxData && vm.privateRxBinding && vm.publicRxBinding) {
    return {
      privateRxData: vm.privateRxData,
      publicRxData: vm.publicRxData,
      privateRxBinding: vm.privateRxBinding,
      publicRxBinding: vm.publicRxBinding,
    };
  }

  const state = createRxGraphState(vm);
  const privateRxData = createPrivateRxData(state);
  const publicRxData = createPublicRxData(privateRxData);
  const privateBinding = createRxBinding(() => {
    state.semanticLog.dispose();
    state.historyLog.dispose();
    state.promptLog.dispose();
    state.sessionLog.dispose();
    state.observabilityLog.dispose();
    state.observabilityErrorLog.dispose();
    state.controlSignalLog.dispose();
    state.graph.dispose();
  });
  const publicBinding = createRxBinding();

  const semanticSubscription = vm.eventBus?.addConsumer((event) => {
    privateRxData.semanticEvents.append(event);
  });
  if (semanticSubscription) {
    privateBinding.addCleanup(() => semanticSubscription.unsubscribe());
  }

  vm.privateRxData = privateRxData;
  vm.publicRxData = publicRxData;
  vm.privateRxBinding = privateBinding;
  vm.publicRxBinding = publicBinding;

  return {
    privateRxData,
    publicRxData,
    privateRxBinding: privateBinding,
    publicRxBinding: publicBinding,
  };
}

function createRxGraphState(vm: AiAgentVm): RxGraphState {
  const graph = new DataGraph<RxDataRuntime>(() => ({ vm }));
  graph.addSignal<AiAgentVmUsageData>("usage", ZERO_USAGE);
  graph.addSignal<AiAgentVmTraceSummaryData>("traceSummary", EMPTY_TRACE_SUMMARY);
  graph.addSignal<AiAgentVmSchedulerSignalData>("scheduler", EMPTY_SCHEDULER_SIGNAL);

  return {
    graph,
    semanticLog: new AppendOnlyEventLog<SemanticEvent>(),
    historyLog: new AppendOnlyEventLog<AiAgentVmDomainRxEvent>(),
    promptLog: new AppendOnlyEventLog<AiAgentVmDomainRxEvent>(),
    sessionLog: new AppendOnlyEventLog<AiAgentVmDomainRxEvent>(),
    observabilityLog: new AppendOnlyEventLog<ObservabilityRecord>(),
    observabilityErrorLog: new AppendOnlyEventLog<ObservabilityRecord>(),
    controlSignalLog: new AppendOnlyEventLog<AiAgentVmControlSignalStreamEvent>(),
  };
}

function createPrivateRxData(state: RxGraphState): AiAgentVmPrivateRxData {
  return {
    semanticEvents: createWritableLogStream(state.semanticLog, (event) => {
      state.graph.set<AiAgentVmTraceSummaryData>("traceSummary", (prev) => ({
        eventCount: prev.eventCount + 1,
        lastEventAt: event.trace?.emitted_at ?? Date.now(),
      }));
    }),
    historyDomainStream: createWritableLogStream(state.historyLog),
    promptDomainStream: createWritableLogStream(state.promptLog),
    sessionDomainStream: createWritableLogStream(state.sessionLog),
    observabilityRecords: createWritableLogStream(state.observabilityLog),
    observabilityErrors: createWritableLogStream(state.observabilityErrorLog),
    controlSignals: createWritableLogStream(state.controlSignalLog),
    usage: createWritableGraphSignal(state.graph, "usage"),
    traceSummary: createWritableGraphSignal(state.graph, "traceSummary"),
    scheduler: createWritableGraphSignal(state.graph, "scheduler"),
  };
}

function createPublicRxData(privateRxData: AiAgentVmPrivateRxData): AiAgentVmPublicRxData {
  return {
    semanticEvents: readonlyStream(privateRxData.semanticEvents),
    historyDomainStream: readonlyStream(privateRxData.historyDomainStream),
    promptDomainStream: readonlyStream(privateRxData.promptDomainStream),
    sessionDomainStream: readonlyStream(privateRxData.sessionDomainStream),
    observabilityRecords: readonlyStream(privateRxData.observabilityRecords),
    observabilityErrors: readonlyStream(privateRxData.observabilityErrors),
    controlSignals: readonlyStream(privateRxData.controlSignals),
    usage: readonlySignal(privateRxData.usage),
    traceSummary: readonlySignal(privateRxData.traceSummary),
    scheduler: readonlySignal(privateRxData.scheduler),
  };
}

function createWritableLogStream<TEvent>(
  log: AppendOnlyEventLog<TEvent>,
  afterAppend?: (event: TEvent) => void,
): AiAgentVmWritableRxStream<TEvent> {
  return {
    append: (event) => {
      log.append(event);
      afterAppend?.(event);
    },
    subscribe: (listener) => {
      const subscription = log.stream({ replay: false }).subscribe({
        next: (entry) => listener(entry.value),
        error: () => {},
        complete: () => {},
      });
      return { unsubscribe: () => subscription.unsubscribe() };
    },
  };
}

function createWritableGraphSignal<TValue>(
  graph: DataGraph<RxDataRuntime>,
  id: string,
): AiAgentVmWritableRxSignal<TValue> {
  return {
    get: () => graph.get<TValue>(id),
    set: (value) => graph.set<TValue>(id, value),
    subscribe: (listener) => {
      const stop = watch(() => graph.get<TValue>(id), listener, { immediate: true });
      return { unsubscribe: () => stop() };
    },
  };
}

function readonlyStream<TEvent>(stream: AiAgentVmRxStream<TEvent>): AiAgentVmRxStream<TEvent> {
  return {
    subscribe: (listener) => stream.subscribe(listener),
  };
}

function readonlySignal<TValue>(
  signal: AiAgentVmReadonlyRxSignal<TValue>,
): AiAgentVmReadonlyRxSignal<TValue> {
  return {
    get: () => signal.get(),
    subscribe: (listener) => signal.subscribe(listener),
  };
}

function createRxBinding(onDispose?: () => void): AiAgentVmRxBinding & { addCleanup: (cleanup: () => void) => void } {
  const cleanups: Array<() => void> = [];
  let disposed = false;
  return {
    addCleanup: (cleanup) => {
      if (disposed) {
        cleanup();
        return;
      }
      cleanups.push(cleanup);
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const cleanup of cleanups.splice(0)) {
        cleanup();
      }
      onDispose?.();
    },
  };
}

export function bindVmDomainRxStreams(params: {
  vm: AiAgentVm;
  history?: AiAgentVmRxStream<AiAgentVmDomainRxEvent>;
  prompt?: AiAgentVmRxStream<AiAgentVmDomainRxEvent>;
  session?: AiAgentVmRxStream<AiAgentVmDomainRxEvent>;
}): AiAgentVmRxBinding {
  const { privateRxData } = ensureVmRxData(params.vm);
  const binding = createRxBinding();
  const subscribe = (
    source: AiAgentVmRxStream<AiAgentVmDomainRxEvent> | undefined,
    target: AiAgentVmWritableRxStream<AiAgentVmDomainRxEvent>,
  ): void => {
    if (!source) return;
    const subscription = source.subscribe((event) => target.append(event));
    binding.addCleanup(() => subscription.unsubscribe());
  };

  subscribe(params.history, privateRxData.historyDomainStream);
  subscribe(params.prompt, privateRxData.promptDomainStream);
  subscribe(params.session, privateRxData.sessionDomainStream);
  return binding;
}
