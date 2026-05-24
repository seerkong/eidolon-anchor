import type { ExampleRouteConfig } from "../contract";

export const normalizeRoutes = (routes: ExampleRouteConfig[]): ExampleRouteConfig[] =>
  routes.map((route) => ({
    ...route,
    path: route.path.startsWith("/") ? route.path : `/${route.path}`,
  }));
