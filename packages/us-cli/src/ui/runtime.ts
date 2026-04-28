/**
 * Pure data + persistence handed to the React app. Keeps `App.tsx`
 * entirely free of node:fs / node:path concerns.
 */
import { promises as fs } from "node:fs";

export interface ChatRuntime {
  profileName: string;
  profileSource: string;
  providerId: string;
  modelId: string;
  /** Context window of the chat model. Used by compaction. */
  contextWindow: number;
  /** Smaller / cheaper model used for summarization. */
  summarizerModel: string;
  systemPrompt?: string;
  /** Non-fatal provider/auth issue discovered while loading the profile. */
  authWarning?: string;
  token: string;
  sessionId: string;
  sessionFile: string;
  maxSteps: number;
  persist(entry: unknown): Promise<void>;
  exit(code: number): void;
}

export function makePersister(sessionFile: string): (e: unknown) => Promise<void> {
  return async (entry: unknown) => {
    await fs.appendFile(sessionFile, JSON.stringify(entry) + "\n");
  };
}
