import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface AppConfig {
  endpoint: string;
  token: string;
}

/** What the UI is allowed to see: the token never leaves the container. */
export interface PublicConfig {
  endpoint: string;
  tokenSet: boolean;
  tokenHint: string;
}

export const dataDir = process.env.DATA_DIR ?? join(process.cwd(), "data");

const file = join(dataDir, "config.json");

let current: AppConfig = load();

function load(): AppConfig {
  try {
    const stored = JSON.parse(readFileSync(file, "utf8")) as Partial<AppConfig>;
    return { endpoint: stored.endpoint ?? "", token: stored.token ?? "" };
  } catch {
    return { endpoint: "", token: "" };
  }
}

export function getConfig(): AppConfig {
  return current;
}

export function isConfigured(): boolean {
  return current.endpoint !== "" && current.token !== "";
}

export function normalizeEndpoint(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Endpoint must be an http(s) URL");
  }
  return trimmed;
}

export function saveConfig(next: AppConfig): void {
  current = next;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
}

export function toPublic(cfg: AppConfig): PublicConfig {
  return {
    endpoint: cfg.endpoint,
    tokenSet: cfg.token !== "",
    tokenHint: cfg.token ? `…${cfg.token.slice(-4)}` : "",
  };
}
