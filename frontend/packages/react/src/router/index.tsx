import { createBrowserRouter } from "react-router-dom";
import { buildMenusAndRoutes } from "./builder";
import { routeResources } from "./resources";
import { AppLayout } from "../layout/AppLayout";
import { NotFound } from "../views/NotFound";

const { menus, routes } = buildMenusAndRoutes(routeResources);

export const appMenus = menus;
export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppLayout menus={menus} />,
    children: [
      ...routes,
      { path: "*", element: <NotFound /> },
    ],
  },
]);
