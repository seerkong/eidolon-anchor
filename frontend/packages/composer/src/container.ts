import "reflect-metadata";
import { Container } from "inversify";
import { HttpClient, createFetchHttpClient } from "@frontend/core";
import { exampleModule } from "./modules/Example/container";

export const TYPES = {
  HttpClient: Symbol("HttpClient"),
};

export const createMosaicContainer = (httpClient?: HttpClient) => {
  const container = new Container();
  container.bind<HttpClient>(TYPES.HttpClient).toConstantValue(httpClient ?? createFetchHttpClient());
  container.load(exampleModule);
  return container;
};
