import type { ApiResponse } from "@shared/composer";

export type HandlerContext = {
  body: any;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  request: Request;
  setHeader: (key: string, value: string) => void;
  error: (status: number, payload: any) => ApiResponse<any>;
  log?: (message: string) => void;
};

export type GetEndpoint = (ctx: HandlerContext) => Promise<ApiResponse<any>>;
export type PostEndpoint = (ctx: HandlerContext) => Promise<ApiResponse<any>>;
export type PutEndpoint = (ctx: HandlerContext) => Promise<ApiResponse<any>>;
export type DeleteEndpoint = (ctx: HandlerContext) => Promise<ApiResponse<any>>;

export type SseEndpoint = (ctx: HandlerContext) => Promise<Response>;

export type WsEndpoint = {
  open?: (ws: any) => void;
  close?: (ws: any) => void;
  message?: (ws: any, message: any) => void;
};
