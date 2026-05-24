export interface HttpRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: any;
  responseType?: "json" | "stream";
}

export interface HttpResponse<T = any> {
  status: number;
  ok: boolean;
  data: T;
  raw?: Response;
}

export interface HttpClient {
  request<T = any>(req: HttpRequest): Promise<HttpResponse<T>>;
}

export interface Logger {
  log(message: string): void;
}

export interface Clock {
  now(): Date;
}
