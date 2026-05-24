import type { ExampleRouteConfig } from "@frontend/core/modules/Example/contract";

// Placeholder controller demonstrating module structure.
export class ExampleModuleController {
  routes: ExampleRouteConfig[];

  constructor(routes: ExampleRouteConfig[] = []) {
    this.routes = routes;
  }

  getRegisteredRoutes() {
    return this.routes;
  }
}
