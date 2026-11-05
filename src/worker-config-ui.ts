import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionInventory } from "./worker-extensions.ts";
import { saveWorkerConfiguration, validateWorkerConfiguration, workerConfiguration } from "./config.ts";
import { isRecord } from "./connection.ts";

/** Rerunnable inventory review; no extension is imported and no preset is silently rewritten. */
export async function showWorkerConfig(ctx: ExtensionContext, projectConfig: boolean, parentInventory: () => Promise<ExtensionInventory>): Promise<void> {
  const inventory = await parentInventory();
  const project = projectConfig && ctx.isProjectTrusted() && inventory.trusted;
  const effective = workerConfiguration(ctx.cwd, project);
  const scope = await ctx.ui.select("Worker extensions: where should this configuration be saved?", ["User defaults", ...(project ? ["Trusted project override"] : [])]);
  if (!scope) return;
  const current = workerConfiguration(ctx.cwd, scope === "Trusted project override").config;
  const seed = current ?? {
    defaultPreset: "worker", required: [],
    presets: { worker: { extensions: inventory.entries.filter(entry => entry.enabled).map(entry => entry.id) }, full: { extensions: "all" }, minimal: { extensions: [] } },
  };
  const text = await ctx.ui.editor("Edit presets and required safety/auth IDs. Inventory/provenance fields are read-only. heapMb is optional (not an RSS limit).", JSON.stringify({
    ...seed,
    _effective: effective.config ?? null,
    _sources: effective.sources,
    _projectOverrides: project ? "enabled for this trusted cwd" : "disabled (requires --teams-project-config and native Pi trust)",
    _inventory: inventory.entries.map(({ id, enabled, scope, source, version }) => ({ id, enabled, scope, source, version })),
    _coordination: "ac-teams is always injected. Only enabled (actually parent-loaded) IDs can seed a child; full means this parent set, not installed extensions.",
  }, null, 2));
  if (text === undefined) return;
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("Worker configuration must be valid JSON; nothing was saved"); }
  if (!isRecord(value)) throw new Error("Invalid worker configuration");
  for (const key of ["_effective", "_sources", "_projectOverrides", "_inventory", "_coordination"]) delete value[key];
  validateWorkerConfiguration(value);
  if (!await ctx.ui.confirm("Save worker extension policy?", "Confirm required includes every safety/provider extension your workers need. Selected code runs with the member's access. Presets apply to new launches; resumes retain saved IDs. No installed extensions are changed.")) return;
  value.reviewed = { ...value.reviewed, [ctx.cwd]: inventory.fingerprint };
  saveWorkerConfiguration(ctx.cwd, scope === "User defaults" ? "user" : "project", value);
  ctx.ui.notify("Worker presets saved and current inventory reviewed. New launches use this policy; resumes keep their saved IDs.", "info");
}
