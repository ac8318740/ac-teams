import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "./connection.ts";

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
