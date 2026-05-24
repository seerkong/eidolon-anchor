import { inject, provide } from "vue";
import type { Container, interfaces } from "inversify";

export const inversifyContainerKey = "inversify-container";

export const provideContainer = (container: Container) => {
  provide(inversifyContainerKey, container);
};

export const useContainer = (): Container => {
  const container = inject<Container>(inversifyContainerKey);
  if (!container) throw new Error("Container is not provided. Call provideContainer first.");
  return container;
};

export const useInject = <T>(Model: interfaces.ServiceIdentifier<T>) => {
  const container = useContainer();
  if (import.meta.hot && !container.isBound(Model)) {
    container.bind(Model).toSelf().inSingletonScope();
  }
  return container.get(Model);
};
