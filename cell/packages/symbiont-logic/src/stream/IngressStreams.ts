import { OutputStream, TeeOutputStream } from "./stream";

export class IngressStreams {
  timeline = new OutputStream();
  control = new TeeOutputStream(this.timeline);
  think = new TeeOutputStream(this.timeline);
  content = new TeeOutputStream(this.timeline);
  tool = new TeeOutputStream(this.timeline);
}
