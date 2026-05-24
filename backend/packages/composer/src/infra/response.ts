import { ApiResponse } from "@shared/composer";

export const ok = <T>(data: T): ApiResponse<T> => ({ code: 0, data });
export const fail = (message: string, error?: string): ApiResponse<null> => ({
  code: 1,
  message,
  error: error ?? message,
});
