import { ContainerModule, interfaces } from "inversify";
import { ExampleApiImpl } from "@frontend/core";

export const exampleModule = new ContainerModule((bind: interfaces.Bind) => {
  bind(ExampleApiImpl).toSelf().inSingletonScope();
});
