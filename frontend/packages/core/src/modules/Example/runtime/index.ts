import type { ExampleRouteConfig, ExampleRuntime } from "../contract";

export const buildExampleRuntimeConfig = (routes: ExampleRouteConfig[]) => ({
  routes,
});

export const withExampleDefaults = (runtime: ExampleRuntime): ExampleRuntime => runtime;
