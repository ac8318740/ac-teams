import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExtensionInventory } from "../settings/worker-extensions.ts";
import { saveWorkerConfiguration, validateWorkerConfiguration, workerConfiguration } from "../settings/config.ts";

export const WorkerConfigSchema = Type.Object({
  action: Type.Union([Type.Literal("read"), Type.Literal("save")]),
  scope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("project")])),
  workers: Type.Optional(Type.Unknown({ description: "Complete worker policy for save: {defaultPreset?: string, required: string[], presets: {[name]: {extensions: string[] | 'all', heapMb?: integer (128..6144)}}}. Preserve existing presets and requirements unless the user requests changes. Read first for current policy and exact extension IDs. Inventory review metadata is managed automatically." })),
}, { additionalProperties: false });

export const workerConfigPrompt = `Help me configure the team's worker extensions through a conversation.
First call team_config with action read to inspect the current policy and actual parent-loaded extension inventory.
Ask what I want workers to do and which tools they need. Use an available question tool if helpful, otherwise ask in chat. Keep questions brief and explain extension choices in plain language, not raw IDs. Do not open an editor, build a TUI wizard, or ask me to edit files.
Ask where to save (user defaults, or project overrides only if allowed). Recommend a lean default and useful presets based on my answers; do not guess which safety/provider/auth extensions are required. Explain what omitted extensions remove. Preserve existing presets, heap limits, and required IDs unless I ask to change them. Coordination is always included; full means only this parent's loaded set.
Summarize the proposed changes and get my approval before calling team_config with action save, the chosen scope, and the complete workers policy. Use that tool to validate and save, not write/edit/bash. If I cancel, save nothing. New launches use the policy; resumes keep their saved IDs. Display toggles remain available through /teams config display.`;

/** Metadata-only discovery and validated persistence for the Pi-led configuration conversation. */
export async function configureWorker(ctx: ExtensionContext, projectConfig: boolean, parentInventory: () => Promise<ExtensionInventory>, args: { action: "read" | "save"; scope?: "user" | "project"; workers?: unknown }) {
  const inventory = await parentInventory();
  const projectAllowed = projectConfig && ctx.isProjectTrusted() && inventory.trusted;
  const user = workerConfiguration(ctx.cwd, false);
  const effective = workerConfiguration(ctx.cwd, projectAllowed);
  if (args.action === "read") return {
    user, effective, projectAllowed,
    inventory: inventory.entries.map(({ id, enabled, scope, source, version }) => ({ id, parentLoaded: enabled, scope, source, version })),
    suggested: user.config ?? {
      defaultPreset: "worker", required: [],
      presets: { worker: { extensions: inventory.entries.filter(entry => entry.enabled).map(entry => entry.id) }, full: { extensions: "all" }, minimal: { extensions: [] } },
    },
  };
  if (args.action !== "save") throw new Error("Unknown worker configuration action");
  if (ctx.mode !== "tui") throw new Error("Saving worker configuration requires an interactive terminal");
  if (args.scope !== "user" && args.scope !== "project") throw new Error("Choose user or project scope before saving");
  if (args.scope === "project" && !projectAllowed) throw new Error("Project configuration requires --teams-project-config and native Pi project trust");
  validateWorkerConfiguration(args.workers);
  const value = structuredClone(args.workers);
  const summary = Object.entries(value.presets).map(([name, preset]) => `${name}: ${preset.extensions === "all" ? "all parent-loaded extensions" : preset.extensions.join(", ") || "no optional extensions"}${preset.heapMb ? `; heap ${preset.heapMb} MB` : ""}`).join("\n");
  if (!await ctx.ui.confirm("Save worker extension policy?", `Scope: ${args.scope}\nDefault: ${value.defaultPreset ?? "none"}\nRequired: ${value.required.join(", ") || "none"}\n${summary}\nConfirm required includes every safety/provider extension your workers need. Selected code runs with the member's access. New launches use this policy; resumes keep saved IDs. No installed extensions are changed.`)) return { saved: false };
  value.reviewed = { ...(args.scope === "user" ? user.config : effective.config)?.reviewed, ...value.reviewed, [ctx.cwd]: inventory.fingerprint };
  saveWorkerConfiguration(ctx.cwd, args.scope, value);
  return { saved: true, scope: args.scope, ...workerConfiguration(ctx.cwd, projectAllowed) };
}
