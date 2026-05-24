import React from "react";
import { RouterProvider } from "react-router-dom";
import { router } from "./router";
import "@frontend/composer/styles/index.css";

const RouterProviderComponent = RouterProvider as unknown as React.ComponentType<{ router: typeof router }>;

export const App: React.FC = () => {
  return <RouterProviderComponent router={router} />;
};
