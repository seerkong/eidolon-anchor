import path from "node:path";

function encodeSegment(value: string): string {
  return encodeURIComponent(String(value ?? "").trim());
}

export type LocalConversationPaths = {
  rootDir: string;
  historyIndexPath: string;
  promptIndexPath: string;
  sessionIndexPath: string;
  artifactRefsPath: string;
  historyGenerationsDir: string;
  promptGenerationsDir: string;
};

export function getLocalConversationPaths(sessionDir: string): LocalConversationPaths {
  const rootDir = path.join(sessionDir, "conversation");
  return {
    rootDir,
    historyIndexPath: path.join(rootDir, "history.index.json"),
    promptIndexPath: path.join(rootDir, "prompt.index.json"),
    sessionIndexPath: path.join(rootDir, "session.index.json"),
    artifactRefsPath: path.join(rootDir, "artifact-refs.index.json"),
    historyGenerationsDir: path.join(rootDir, "history-generations"),
    promptGenerationsDir: path.join(rootDir, "prompt-generations"),
  };
}

export function getLocalHistoryGenerationPath(sessionDir: string, generationId: string): string {
  return path.join(getLocalConversationPaths(sessionDir).historyGenerationsDir, `${encodeSegment(generationId)}.json`);
}

export function getLocalPromptGenerationPath(sessionDir: string, promptGenerationId: string): string {
  return path.join(getLocalConversationPaths(sessionDir).promptGenerationsDir, `${encodeSegment(promptGenerationId)}.json`);
}
