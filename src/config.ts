import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord } from "./connection.ts";

export interface DisplaySettings { tasks: boolean; agents: boolean }
export const defaultDisplaySettings: DisplaySettings = { tasks: true, agents: true };
/** ac-teams state outside Pi's agent directory: settings, team stores, and generated member configuration. */
export const stateRoot = () => join(homedir(), ".pi", "ac-teams");
const displayPath = () => join(stateRoot(), "display.json");

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

export interface WorkerPreset { extensions: string[] | "all"; heapMb?: number }
export interface WorkerConfiguration {
  defaultPreset?: string;
  required: string[];
  presets: Record<string, WorkerPreset>;
  reviewed?: Record<string, string>;
}
const identifiers = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 512 && value.every(id => typeof id === "string" && id.length > 0 && id.length <= 4096) && new Set(value).size === value.length;
export function validateWorkerConfiguration(value: unknown): asserts value is WorkerConfiguration {
  if (!isRecord(value) || Object.keys(value).some(key => !["defaultPreset", "required", "presets", "reviewed"].includes(key)) || !identifiers(value.required) || !isRecord(value.presets)) throw new Error("Invalid worker configuration");
  for (const [name, preset] of Object.entries(value.presets)) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(name) || !isRecord(preset) || Object.keys(preset).some(key => !["extensions", "heapMb"].includes(key)) || !(preset.extensions === "all" || identifiers(preset.extensions)) || (preset.heapMb !== undefined && (!Number.isSafeInteger(preset.heapMb) || Number(preset.heapMb) < 128 || Number(preset.heapMb) > 6144))) throw new Error(`Invalid worker preset: ${name}`);
  }
  if (value.defaultPreset !== undefined && (typeof value.defaultPreset !== "string" || !Object.hasOwn(value.presets, value.defaultPreset))) throw new Error("Invalid default worker preset");
  if (value.reviewed !== undefined && (!isRecord(value.reviewed) || Object.values(value.reviewed).some(hash => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)))) throw new Error("Invalid worker inventory review");
}
function readPolicyFile(file: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new Error(`Cannot read team policy ${file}: ${String(error)}`); }
  if (!isRecord(value) || Object.keys(value).some(key => !["limit", "depth", "workers"].includes(key))) throw new Error(`Invalid team policy: ${file}`);
  if (value.workers !== undefined) validateWorkerConfiguration(value.workers);
  return value;
}
export function workerConfiguration(cwd: string, trusted: boolean): { config?: WorkerConfiguration; sources: string[] } {
  const sources: string[] = [];
  let config: WorkerConfiguration | undefined;
  for (const file of [join(stateRoot(), "config.json"), ...(trusted ? [join(cwd, ".pi", "ac-teams.json")] : [])]) {
    const workers = readPolicyFile(file).workers as WorkerConfiguration | undefined;
    if (!workers) continue;
    sources.push(file);
    config = { ...config, ...workers, required: [...new Set([...(config?.required ?? []), ...workers.required])], presets: { ...config?.presets, ...workers.presets }, reviewed: { ...config?.reviewed, ...workers.reviewed } };
    if (!Object.keys(config.reviewed!).length) delete config.reviewed;
  }
  return { config, sources };
}
export function saveWorkerConfiguration(cwd: string, scope: "user" | "project", config: unknown): void {
  validateWorkerConfiguration(config);
  const file = scope === "user" ? join(stateRoot(), "config.json") : join(cwd, ".pi", "ac-teams.json");
  const previous = readPolicyFile(file), temporary = `${file}.${randomUUID()}.tmp`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporary, JSON.stringify({ ...previous, workers: config }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

export function policy(cwd: string, trusted: boolean, flags: { limit?: string; depth?: string }) {
  let config: Record<string, unknown> = { limit: 10, depth: 2 };
  const files = [join(stateRoot(), "config.json")];
  if (trusted) files.push(join(cwd, ".pi", "ac-teams.json"));
  for (const file of files) config = { ...config, ...readPolicyFile(file) };
  const limit = flags.limit === undefined ? config.limit : Number(flags.limit);
  const depth = flags.depth === undefined ? config.depth : Number(flags.depth);
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100 || !Number.isSafeInteger(depth) || Number(depth) < 0 || Number(depth) > 10) throw new Error("Team limit must be 1..100 and depth 0..10");
  if (Number(limit) > 10 && flags.limit === undefined) throw new Error("A ceiling above 10 requires the explicit --teams-limit startup flag");
  return { limit: Number(limit), depth: Number(depth) };
}
