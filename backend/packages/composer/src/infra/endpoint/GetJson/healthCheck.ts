import { InfraApiType, HealthCheckResponse } from "@shared/composer";
import type { GetEndpoint } from "@backend/composer/infra/http";
import { ok } from "@backend/composer/infra/response";
import { logEndpointStart } from "@backend/composer/infra/logging";

export const createHealthCheckEndpoint = (): GetEndpoint => {
  return async ({ log }) => {
    logEndpointStart(log, InfraApiType.HealthCheck);
    const payload: HealthCheckResponse = { status: "ok", timestamp: new Date().toISOString() };
    return ok(payload);
  };
};
