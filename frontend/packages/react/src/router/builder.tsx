import React from "react";
import { createBrowserRouter, Navigate, Outlet, type RouteObject } from "react-router-dom";
import type { AppMenuItem, AppRouteConfig } from "./types";

const OutletComponent = Outlet as unknown as React.ComponentType;

const viewModules = import.meta.glob("../modules/**/view/**/*.{tsx,ts,jsx,js}", { eager: true });
const reactExtensions = [".tsx", ".ts", ".jsx", ".js"];

const normalizePath = (path: string, parentFullPath: string) => {
  if (path.startsWith("/")) return path;
  const base = parentFullPath === "/" ? "" : parentFullPath;
  return `${base}/${path}`.replace(/\/+/g, "/");
};

const resolveElement = (
  component?: string
): { element: React.ReactElement; exists: boolean; isLayout: boolean } => {
  if (!component) return { element: <React.Fragment />, exists: false, isLayout: false };
  if (component === "layout") return { element: <OutletComponent />, exists: true, isLayout: true };
  const base = component.startsWith("../") ? component : `../${component}`;
  const candidate = reactExtensions
    .map((ext) => `${base}${base.endsWith(ext) ? "" : ext}`)
    .find((p) => viewModules[p]);
  const mod = candidate ? (viewModules[candidate] as { default?: React.ComponentType } | undefined) : undefined;
  const Comp = mod?.default;
  if (!Comp) return { element: <React.Fragment />, exists: false, isLayout: false };
  return { element: <Comp />, exists: true, isLayout: false };
};

const toMenu = (config: AppRouteConfig, fullPath: string): AppMenuItem => ({
  key: fullPath,
  title: config.title ?? config.meta?.title ?? "未命名",
  path: config.path,
  fullPath,
  icon: config.meta?.icon as string | undefined,
});

export const buildMenusAndRoutes = (
  configs: AppRouteConfig[],
  parentFullPath = ""
): { menus: AppMenuItem[]; routes: RouteObject[] } => {
  const menus: AppMenuItem[] = [];
  const routes: RouteObject[] = [];

  for (const cfg of configs) {
    const meta = cfg.meta ?? {};
    const title = cfg.title ?? meta.title ?? "未命名";
    const fullPath = normalizePath(cfg.path, parentFullPath || "/");

    const resolved = resolveElement(cfg.component);
    const child = cfg.children && cfg.children.length ? buildMenusAndRoutes(cfg.children, fullPath) : { menus: [], routes: [] };
    const hasChildren = child.routes.length > 0;
    const hasComponent = resolved.exists || resolved.isLayout;

    let menu: AppMenuItem | null = null;
    if (meta.isMenu !== false) {
      if (hasComponent || child.menus.length > 0) {
        menu = toMenu(cfg, fullPath);
        if (child.menus.length) menu.children = child.menus;
      }
    }

    let route: RouteObject | null = null;
    if (meta.isRoute !== false && cfg.path && (hasComponent || cfg.redirect || hasChildren)) {
      if (cfg.redirect) {
        route = { path: cfg.path, element: <Navigate to={cfg.redirect} replace />, handle: { title, meta } };
      } else {
        route = {
          path: cfg.path,
          element: hasComponent ? resolved.element : <OutletComponent />,
          handle: { title, meta, fullPath },
          children: child.routes,
        };
      }
    }

    if (menu) menus.push(menu);
    if (route) routes.push(route);
  }

  return { menus, routes };
};

export const createAppRouter = (routes: RouteObject[]) => createBrowserRouter(routes);
