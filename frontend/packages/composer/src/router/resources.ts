import type { AppRouteConfig } from "./types";
import { allFrontendModuleManifests } from "../modules";

export const routeResources: AppRouteConfig[] = [
  {
    path: "/",
    redirect: "/example/post",
    meta: { isMenu: false, title: "home" },
  },
  ...allFrontendModuleManifests.flatMap((manifest) => manifest.routes ?? []),
];
