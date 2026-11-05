import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { DefaultPackageManager, getAgentDir, hasTrustRequiringProjectResources, ProjectTrustStore, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import type { WorkerConfiguration } from "./config.ts";
import { isRecord } from "./connection.ts";

export interface ExtensionChoice { preset?: string; include?: string[]; exclude?: string[] }
export interface ExtensionEntry {
  id: string; path: string; enabled: boolean; scope: string; source: string; version?: string; fingerprint: string;
}
export interface ExtensionInventory { entries: ExtensionEntry[]; fingerprint: string; trusted: boolean }
export interface ExtensionSelection {
  preset: string; ids: string[]; required: string[]; fingerprints: Record<string, string>;
  inventory: string; heapMb?: number; warnings: string[]; excluded: string[];
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const projectTrusted = (cwd: string, agentDir = getAgentDir()) => !hasTrustRequiringProjectResources(cwd) || new ProjectTrustStore(agentDir).get(cwd) === true;

/** Metadata only: installed extension factories are never called or imported here. */
export async function extensionInventory(cwd: string, agentDir = getAgentDir(), loadedPaths?: readonly string[]): Promise<ExtensionInventory> {
  const trusted = projectTrusted(cwd, agentDir);
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
  const errors = settings.drainErrors();
  if (errors.length) throw new Error(`Cannot inventory Pi settings: ${errors.map(error => error.error.message).join("; ")}`);
  // Observe built-ins or name them from settings; importing their registry would import excluded module code.
  const references = [...(loadedPaths ?? []), ...(settings.getGlobalSettings().extensions ?? []), ...(trusted ? settings.getProjectSettings().extensions ?? [] : [])];
  const builtinExtensions = [...new Set(references.flatMap(value => { const match = /^[-+]?builtin:([a-zA-Z0-9_.-]+)$/.exec(value); return match ? [match[1]] : []; }))];
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings, builtinExtensions });
  const resources = await manager.resolve(async () => "skip");
  const roots = new Map<string, string>();
  const entries: ExtensionEntry[] = [];
  for (const resource of resources.extensions) {
    const { metadata, path } = resource;
    let id: string, fingerprint: string, version: string | undefined;
    if (path.startsWith("builtin:")) { id = path; version = VERSION; fingerprint = hash(`${path}:${VERSION}`); }
    else {
      const root = metadata.packageRoot ?? path;
      let manifest: { name?: string; version?: string } = {};
      if (metadata.packageRoot) {
        try { manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      // The coordinator is always injected from this running copy, never a second installed copy.
      if (manifest.name === "ac-teams") continue;
      version = manifest.version;
      id = metadata.packageRoot
        ? `${metadata.scope}:package:${manifest.name ?? metadata.source}:${relative(root, path)}`
        : `${metadata.scope}:${relative(metadata.scope === "project" ? join(cwd, ".pi") : agentDir, path)}`;
      let tree = roots.get(root);
      if (!tree) { tree = treeFingerprint(root); roots.set(root, tree); }
      fingerprint = hash(`${tree}:${relative(root, path)}`);
    }
    if (entries.some(entry => entry.id === id)) throw new Error(`Ambiguous extension ID: ${id}`);
    entries.push({ id, path, enabled: resource.enabled, scope: metadata.scope, source: metadata.source, version, fingerprint });
  }
  if (loadedPaths) {
    const loaded = new Set(loadedPaths);
    for (const entry of entries) entry.enabled = loaded.has(entry.path);
    for (const path of loaded) {
      if (entries.some(entry => entry.path === path)) continue;
      if (path.startsWith("<")) { entries.push({ id: `inline:${path}`, path, enabled: false, scope: "runtime", source: path, fingerprint: hash(path) }); continue; }
      const fingerprint = path.startsWith("builtin:") ? hash(`${path}:${VERSION}`) : treeFingerprint(path);
      entries.push({ id: `explicit:${path}`, path, enabled: true, scope: "runtime", source: path, fingerprint });
    }
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return { entries, trusted, fingerprint: hash(JSON.stringify(entries.map(({ id, enabled, fingerprint }) => ({ id, enabled, fingerprint })))) };
}

function treeFingerprint(root: string): string {
  const digest = createHash("sha256");
  const walk = (path: string) => {
    const stat = lstatSync(path, { bigint: true });
    digest.update(`${relative(root, path)}:${stat.size}:${stat.mtimeNs}:${stat.ino}\n`);
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) {
      if (!["node_modules", ".git", ".pi", ".cache", "coverage"].includes(name)) walk(join(path, name));
    }
  };
  // shortcut: standalone-file helpers, nested dependencies, and unchanged metadata need manual inventory review.
  walk(root);
  return digest.digest("hex");
}

export function selectExtensions(inventory: ExtensionInventory, config?: WorkerConfiguration, request?: ExtensionChoice, saved?: ExtensionSelection, inheritedRequired: string[] = []): ExtensionSelection | undefined {
  if (saved && request) throw new Error("Resume keeps saved extension IDs; use a new launch to change selection");
  if (!config && !request && !saved) {
    if (inheritedRequired.length) throw new Error("Worker policy is missing; cannot preserve the parent's required extensions");
    return undefined;
  }
  const preset = saved?.preset ?? request?.preset ?? config?.defaultPreset;
  if (!saved && (!preset || !config || !Object.hasOwn(config.presets, preset))) throw new Error(`Unknown worker preset: ${preset ?? "(no default configured)"}`);
  const configured = !saved && config ? config.presets[preset!] : undefined;
  const required = [...new Set([...(saved?.required ?? []), ...(config?.required ?? []), ...inheritedRequired])];
  if (saved && required.some(id => !saved.ids.includes(id))) throw new Error("Required extensions changed; resume cannot change its saved IDs. Use a new launch");
  const ids = new Set(saved?.ids ?? (configured?.extensions === "all" ? inventory.entries.filter(entry => entry.enabled).map(entry => entry.id) : configured?.extensions ?? []));
  for (const id of required) ids.add(id);
  for (const id of request?.include ?? []) ids.add(id);
  for (const id of request?.exclude ?? []) {
    if (required.includes(id)) throw new Error(`Cannot exclude required extension: ${id}`);
    if (!inventory.entries.some(entry => entry.id === id)) throw new Error(`Unknown extension: ${id}`);
    ids.delete(id);
  }
  const warnings: string[] = [], fingerprints: Record<string, string> = {};
  for (const id of ids) {
    const entry = inventory.entries.find(entry => entry.id === id && entry.enabled);
    if (!entry) {
      if (saved && !required.includes(id)) { warnings.push(`Saved extension unavailable or disabled (not loaded): ${id}`); continue; }
      throw new Error(`${required.includes(id) ? "Required extension" : "Extension"} unavailable or disabled: ${id}`);
    }
    fingerprints[id] = entry.fingerprint;
    if (saved && saved.fingerprints[id] !== entry.fingerprint) warnings.push(`Installed extension changed (current code will load): ${id}`);
  }
  return { preset: preset!, ids: [...ids].sort(), required, fingerprints, inventory: inventory.fingerprint, heapMb: saved?.heapMb ?? configured?.heapMb, warnings, excluded: inventory.entries.filter(entry => !ids.has(entry.id)).map(entry => entry.id) };
}

export function selectedExtensionArgs(selection: ExtensionSelection, inventory: ExtensionInventory, coordinator: string): string[] {
  const paths = new Set<string>();
  for (const id of selection.ids) {
    const entry = inventory.entries.find(entry => entry.id === id && entry.enabled);
    if (entry) paths.add(entry.path.startsWith("builtin:") ? entry.path : resolve(entry.path));
  }
  paths.delete(resolve(coordinator));
  return ["-ne", ...[...paths].flatMap(path => ["-e", path])];
}

export function validExtensionSelection(value: unknown): value is ExtensionSelection {
  const ids = (list: unknown): list is string[] => Array.isArray(list) && list.length <= 512 && list.every(id => typeof id === "string" && id.length > 0 && id.length <= 4096) && new Set(list).size === list.length;
  if (!isRecord(value) || !ids(value.ids) || !ids(value.required) || !ids(value.excluded)) return false;
  const selected = value.ids;
  return typeof value.preset === "string" && value.required.every(id => selected.includes(id))
    && typeof value.inventory === "string" && /^[a-f0-9]{64}$/.test(value.inventory) && isRecord(value.fingerprints) && Object.entries(value.fingerprints).every(([id, hash]) => selected.includes(id) && typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))
    && Array.isArray(value.warnings) && value.warnings.every(warning => typeof warning === "string") && (value.heapMb === undefined || Number.isSafeInteger(value.heapMb) && Number(value.heapMb) >= 128 && Number(value.heapMb) <= 6144);
}

/** Old-space is a V8 allowance, not an RSS limit; preserve unrelated Node options. */
export function workerNodeOptions(inherited: string | undefined, heapMb: number): string {
  return `${(inherited ?? "").replace(/(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s+)\d+(?=\s|$)/g, "").trim()} --max-old-space-size=${heapMb}`.trim();
}
