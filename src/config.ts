import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord } from "./connection.ts";

export interface DisplaySettings { tasks: boolean; agents: boolean }
export const defaultDisplaySettings: DisplaySettings = { tasks: true, agents: true };
const displayPath = () => join(homedir(), ".acstack", "ac-teams", "display.json");

export function readDisplaySettings(): DisplaySettings {
  let value: unknown;
  try { value = JSON.parse(readFileSync(displayPath(), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...defaultDisplaySettings };
    throw new Error(`Cannot read teams display settings: ${String(error)}`);
  }
  if (!isRecord(value) || Object.keys(value).some(key => !["tasks", "agents"].includes(key) || typeof value[key] !== "boolean")) throw new Error("Invalid teams display settings");
  return { ...defaultDisplaySettings, ...value };
}

export function saveDisplaySettings(value: DisplaySettings): void {
  readDisplaySettings(); // Do not replace an unreadable or malformed preferences file.
  if (typeof value.tasks !== "boolean" || typeof value.agents !== "boolean") throw new Error("Invalid teams display settings");
  const path = displayPath(), temporary = `${path}.${randomUUID()}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporary, JSON.stringify({ tasks: value.tasks, agents: value.agents }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

export function policy(cwd: string, trusted: boolean, flags: { limit?: string; depth?: string }) {
  let config: Record<string, unknown> = { limit: 10, depth: 2 };
  const files = [join(homedir(), ".acstack", "ac-teams", "config.json")];
  if (trusted) files.push(join(cwd, ".pi", "ac-teams.json"));
  for (const file of files) {
    let value: unknown;
    try { value = JSON.parse(readFileSync(file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw new Error(`Cannot read team policy ${file}: ${String(error)}`); }
    if (!isRecord(value) || Object.keys(value).some(key => !["limit", "depth"].includes(key))) throw new Error(`Invalid team policy: ${file}`);
    config = { ...config, ...value };
  }
  const limit = flags.limit === undefined ? config.limit : Number(flags.limit);
  const depth = flags.depth === undefined ? config.depth : Number(flags.depth);
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100 || !Number.isSafeInteger(depth) || Number(depth) < 0 || Number(depth) > 10) throw new Error("Team limit must be 1..100 and depth 0..10");
  if (Number(limit) > 10 && flags.limit === undefined) throw new Error("A ceiling above 10 requires the explicit --teams-limit startup flag");
  return { limit: Number(limit), depth: Number(depth) };
}
