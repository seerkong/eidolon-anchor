import React, { createContext, useContext } from "react";
import { createMosaicContainer } from "@frontend/composer";

type ContainerInstance = ReturnType<typeof createMosaicContainer>;
type ServiceIdentifier<T> = string | symbol | (new (...args: any[]) => T);

const ContainerContext = createContext<ContainerInstance | null>(null);

export const ContainerProvider: React.FC<{ container?: ContainerInstance; children: React.ReactNode }> = ({
  container,
  children,
}) => {
  const value = container ?? createMosaicContainer();
  return <ContainerContext.Provider value={value}>{children}</ContainerContext.Provider>;
};

export const useContainer = () => {
  const container = useContext(ContainerContext);
  if (!container) throw new Error("Container is not provided");
  return container;
};

export const useInject = <T,>(Model: ServiceIdentifier<T>) => {
  const container = useContainer();
  if (import.meta.hot && !container.isBound(Model)) {
    container.bind(Model).toSelf().inSingletonScope();
  }
  return container.get(Model);
};
