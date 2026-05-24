import { InfraApiType } from "@shared/composer";
import type { GetEndpoint } from "@backend/composer/infra/http";
import { createHealthCheckEndpoint } from "./healthCheck";

export const createInfraGetJsonHandlers = (): Record<string, GetEndpoint> => ({
  [InfraApiType.HealthCheck]: createHealthCheckEndpoint(),
});
