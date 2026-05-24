declare module "koa-websocket" {
  import Koa from "koa";

  type WsMiddleware = (...args: any[]) => any;

  interface KoaWithWebSocket extends Koa {
    ws: {
      use(middleware: WsMiddleware): void;
    };
  }

  export default function websockify(app: Koa): KoaWithWebSocket;
}
