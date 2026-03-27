import { homedir } from "node:os";
import path from "node:path";

export function readtheyDir(): string {
  const fromEnv = process.env.READTHEY_HOME?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(homedir(), ".readthey");
}

export function statePath(): string {
  return path.join(readtheyDir(), "state.json");
}

export function pidPath(): string {
  return path.join(readtheyDir(), "server.pid");
}
