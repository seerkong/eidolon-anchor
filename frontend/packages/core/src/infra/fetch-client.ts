import { HttpClient, HttpRequest, HttpResponse } from "../http";

export const createFetchHttpClient = (): HttpClient => ({
  async request<T>(req: HttpRequest): Promise<HttpResponse<T>> {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
    if (req.responseType === "stream") {
      return { status: res.status, ok: res.ok, data: null as any, raw: res };
    }
    let data: any = null;
    try {
      const text = await res.text();
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text as any;
      }
    } catch {
      data = null;
    }
    return { status: res.status, ok: res.ok, data, raw: res };
  },
});
