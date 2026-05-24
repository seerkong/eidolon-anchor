// Placeholder for cross-module DTOs (none currently).
export type EmptyDTO = Record<string, never>;

export interface HealthCheckResponse {
  status: "ok";
  timestamp: string;
}
