import type { RouteRecordRaw } from "vue-router";
import { buildMenusAndRoutes, createAppRouter } from "./builder";
import { routeResources } from "./resources";

const { menus, routes } = buildMenusAndRoutes(routeResources);

// Ensure a catch-all so history mode works for unknown routes
const notFoundRoute: RouteRecordRaw = {
  path: "/:pathMatch(.*)*",
  name: "not-found",
  component: () => import("../layout/NotFound.vue"),
  meta: { title: "未找到", isMenu: false },
};

export const appMenus = menus;
export const appRoutes: RouteRecordRaw[] = [...routes, notFoundRoute];
export const router = createAppRouter(appRoutes);
