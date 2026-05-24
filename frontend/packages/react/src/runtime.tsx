import React, { createContext, useContext } from "react";
import { createFrontendRuntime } from "@frontend/composer";
import type { FrontendConfig, FrontendRuntime } from "@frontend/composer";

const RuntimeContext = createContext<FrontendRuntime | null>(null);

const resolveConfig = (): FrontendConfig => {
  const env = (() => {
    try {
      return (import.meta as any).env as Record<string, string | undefined>;
    } catch {
      return {};
    }
  })();

  return {
    apiBaseUrl: env?.VITE_API_BASE_URL ?? "",
    modules: {
      Example: {},
    },
  };
};

const defaultRuntime = createFrontendRuntime(resolveConfig());

export const RuntimeProvider: React.FC<{ runtime?: FrontendRuntime; children: React.ReactNode }> = ({
  runtime,
  children,
}) => {
  const value = runtime ?? defaultRuntime;
  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
};

export const useFrontendRuntime = () => {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("Frontend runtime is not provided");
  return runtime;
};
