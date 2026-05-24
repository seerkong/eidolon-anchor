import { IngressStreams } from "./IngressStreams";
import { OutputStream, TeeOutputStream } from "@cell/symbiont-contract/stream/stream";

export class IngressStreamRuntime {
  timelineStream = new OutputStream();
  ingressControl = new TeeOutputStream(this.timelineStream);
  ingressThink = new TeeOutputStream(this.timelineStream);
  ingressContent = new TeeOutputStream(this.timelineStream);
  ingressTool = new TeeOutputStream(this.timelineStream);

  static create() {
    return new IngressStreamRuntime();
  }

  get ingressStreams(): IngressStreams {
    const ingress = new IngressStreams();
    ingress.control = this.ingressControl;
    ingress.think = this.ingressThink;
    ingress.content = this.ingressContent;
    ingress.tool = this.ingressTool;
    ingress.timeline = this.timelineStream;
    return ingress;
  }
}
