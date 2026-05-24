// Common API response wrapper shared across modules
export interface ApiResponse<T = any> {
  code: number;
  data?: T;
  error?: string;
  message?: string;
}

export enum InfraApiType {
  HealthCheck = "/api/health",
}
