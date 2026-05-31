/**
 * SceneStore — file-based scene persistence using xnl-core.
 *
 * Layout: {rootDir}/scenes/{sessionId}/manifest.xnl + events.xnl
 */

import { existsSync, promises as fsp } from "node:fs";
import path from "node:path";
import { parseXnl, XNL } from "xnl-core";
import type { DataElementNode, XnlNode } from "xnl-core";
import {
  manifestToNode,
  nodeToManifest,
  messageToNode,
  nodeToMessage,
  type SceneManifest,
  type SceneMessage,
} from "./SceneTypes";

export class SceneStore {
  constructor(private rootDir: string) {}

  private sceneDir(sessionId: string): string {
    return path.join(this.rootDir, "scenes", sessionId);
  }

  private manifestPath(sessionId: string): string {
    return path.join(this.sceneDir(sessionId), "manifest.xnl");
  }

  private eventsPath(sessionId: string): string {
    return path.join(this.sceneDir(sessionId), "events.xnl");
  }

  async saveManifest(sessionId: string, manifest: SceneManifest): Promise<void> {
    const dir = this.sceneDir(sessionId);
    await fsp.mkdir(dir, { recursive: true });
    const content = XNL.stringify(manifestToNode(manifest), { pretty: true, indent: 2 });
    await fsp.writeFile(this.manifestPath(sessionId), content, "utf8");
  }

  async loadManifest(sessionId: string): Promise<SceneManifest | null> {
    const filePath = this.manifestPath(sessionId);
    if (!existsSync(filePath)) return null;
    const doc = parseXnl(await fsp.readFile(filePath, "utf8"));
    const node = doc.nodes[0];
    return node && isDataElement(node) ? nodeToManifest(node) : null;
  }

  async appendEvent(sessionId: string, node: XnlNode): Promise<void> {
    await fsp.mkdir(this.sceneDir(sessionId), { recursive: true });
    await fsp.appendFile(this.eventsPath(sessionId), XNL.stringify(node) + "\n", "utf8");
  }

  async appendMessage(sessionId: string, msg: SceneMessage): Promise<void> {
    await this.appendEvent(sessionId, messageToNode(msg));
  }

  async loadEvents(sessionId: string): Promise<XnlNode[]> {
    const filePath = this.eventsPath(sessionId);
    if (!existsSync(filePath)) return [];
    return parseXnl(await fsp.readFile(filePath, "utf8")).nodes;
  }

  async loadMessages(sessionId: string): Promise<SceneMessage[]> {
    return (await this.loadEvents(sessionId))
      .filter(isDataElement)
      .filter((n) => n.tag === "Message")
      .map(nodeToMessage);
  }

  async loadScene(sessionId: string): Promise<{ manifest: SceneManifest | null; messages: SceneMessage[] }> {
    const [manifest, messages] = await Promise.all([this.loadManifest(sessionId), this.loadMessages(sessionId)]);
    return { manifest, messages };
  }

  async listSessions(): Promise<string[]> {
    const dir = path.join(this.rootDir, "scenes");
    if (!existsSync(dir)) return [];
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }
}

function isDataElement(n: XnlNode): n is DataElementNode {
  return typeof n === "object" && n !== null && (n as DataElementNode).kind === "DataElement";
}
