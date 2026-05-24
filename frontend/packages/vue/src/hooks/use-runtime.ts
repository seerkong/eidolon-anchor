import type { App } from "vue";
import { inject, provide } from "vue";
import type { FrontendRuntime } from "@frontend/composer";

export const frontendRuntimeKey = "frontend-runtime";

export const provideFrontendRuntime = (runtime: FrontendRuntime, app?: App) => {
  if (app) {
    app.provide(frontendRuntimeKey, runtime);
    return;
  }
  provide(frontendRuntimeKey, runtime);
};

export const useFrontendRuntime = (): FrontendRuntime => {
  const runtime = inject<FrontendRuntime>(frontendRuntimeKey);
  if (!runtime) throw new Error("Frontend runtime is not provided. Call provideFrontendRuntime first.");
  return runtime;
};
