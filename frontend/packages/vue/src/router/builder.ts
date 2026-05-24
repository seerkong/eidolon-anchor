import { createWebHistory, createRouter, type RouteRecordRaw } from "vue-router";
import LayoutPass from "../layout/LayoutPass.vue";
import type { AppMenuItem, AppRouteConfig } from "./types";

const viewModules = import.meta.glob("../modules/**/view/**/*.vue");

const normalizePath = (path: string, parentFullPath: string) => {
  if (path.startsWith("/")) return path;
  const base = parentFullPath === "/" ? "" : parentFullPath;
  return `${base}/${path}`.replace(/\/+/g, "/");
};

const resolveComponent = (
  component?: string
): { comp: any; exists: boolean; isLayout: boolean } => {
  if (!component) return { comp: LayoutPass, exists: false, isLayout: false };
  if (component === "layout") return { comp: LayoutPass, exists: true, isLayout: true };
  const base = component.startsWith("../") ? component : `../${component}`;
  const withExt = base.endsWith(".vue") ? base : `${base}.vue`;
  const match = viewModules[withExt];
  return { comp: match ?? LayoutPass, exists: !!match, isLayout: false };
};

const toMenu = (config: AppRouteConfig, fullPath: string): AppMenuItem => ({
  key: fullPath,
  title: config.title ?? config.meta?.title ?? "未命名",
  path: config.path,
  fullPath,
  icon: config.meta?.icon as string | undefined,
});

export const buildMenusAndRoutes = (configs: AppRouteConfig[], parentFullPath = ""): { menus: AppMenuItem[]; routes: RouteRecordRaw[] } => {
  const menus: AppMenuItem[] = [];
  const routes: RouteRecordRaw[] = [];

  for (const cfg of configs) {
    const meta = cfg.meta ?? {};
    const title = cfg.title ?? meta.title ?? "未命名";
    const fullPath = normalizePath(cfg.path, parentFullPath || "/");
    const resolved = resolveComponent(cfg.component);

    let menu: AppMenuItem | null = null;
    const child = cfg.children && cfg.children.length ? buildMenusAndRoutes(cfg.children, fullPath) : { menus: [], routes: [] };
    const hasChildren = child.routes.length > 0;
    const hasComponent = resolved.exists || resolved.isLayout;

    if (meta.isMenu !== false && (hasComponent || child.menus.length > 0)) {
      menu = toMenu(cfg, fullPath);
      if (child.menus.length) menu.children = child.menus;
    }

    let route: RouteRecordRaw | null = null;
    if (meta.isRoute !== false && cfg.path && (hasComponent || cfg.redirect || hasChildren)) {
      route = {
        path: cfg.path,
        name: cfg.name ?? fullPath,
        redirect: cfg.redirect,
        component: hasComponent ? resolved.comp : LayoutPass,
        meta: { ...meta, title, fullPath },
        children: child.routes,
      };
    }

    if (menu) menus.push(menu);
    if (route) routes.push(route);
  }

  return { menus, routes };
};

export const createAppRouter = (routes: RouteRecordRaw[]) =>
  createRouter({
    history: createWebHistory(),
    routes,
    scrollBehavior: () => ({ top: 0 }),
  });
