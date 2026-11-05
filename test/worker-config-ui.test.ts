import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { showWorkerConfig as configureWorker } from "../src/worker-config-ui.ts";
import { extensionInventory } from "../src/worker-extensions.ts";
import { saveWorkerConfiguration, workerConfiguration } from "../src/config.ts";

test("worker configuration is rerunnable, shows provenance, gates project edits, and preserves cancellation/errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "at-worker-ui-")), cwd = join(root, "project"), agent = join(root, "agent");
  const oldHome = process.env.HOME, oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = root; process.env.PI_CODING_AGENT_DIR = agent;
  mkdirSync(join(agent, "extensions"), { recursive: true }); mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(agent, "extensions", "guard.ts"), "throw new Error('inventory must not import');");
  const showWorkerConfig = (ctx: ExtensionContext, project: boolean) => configureWorker(ctx, project, () => extensionInventory(cwd, agent, [join(agent, "extensions", "guard.ts")]));
  let scope = "User defaults", text: string | undefined, confirmed = true, edited = "", options: string[] = [];
  const ctx = { cwd, isProjectTrusted: () => true, ui: {
    select: async (_title: string, choices: string[]) => { options = choices; return scope; },
    editor: async (_title: string, initial: string) => { edited = initial; return text; },
    confirm: async () => confirmed, notify: () => {},
  } } as unknown as ExtensionContext;
  const userFile = join(root, ".pi", "ac-teams", "config.json"), projectFile = join(cwd, ".pi", "ac-teams.json");
  try {
    await showWorkerConfig(ctx, true);
    assert.deepEqual(options, ["User defaults"], "native saved trust is required despite a trusted caller");
    assert.ok(!existsSync(userFile));
    const seed = JSON.parse(edited);
    assert.ok(seed._inventory.some((entry: { id: string }) => entry.id.includes("guard.ts")));
    assert.equal(seed.defaultPreset, "worker");
    assert.ok(seed.presets.worker.extensions.every((id: string) => typeof id === "string"));
    text = "{";
    await assert.rejects(showWorkerConfig(ctx, false), /valid JSON/);
    assert.ok(!existsSync(userFile));
    text = JSON.stringify({ required: [], defaultPreset: "minimal", presets: { minimal: { extensions: [] } } });
    confirmed = false; await showWorkerConfig(ctx, false); assert.ok(!existsSync(userFile));
    confirmed = true; await showWorkerConfig(ctx, false);
    assert.equal(statSync(userFile).mode & 0o777, 0o600);
    assert.ok(workerConfiguration(cwd, false).config?.reviewed?.[cwd]);
    new ProjectTrustStore(agent).set(cwd, true);
    saveWorkerConfiguration(cwd, "project", { required: [], presets: { project: { extensions: [] } }, defaultPreset: "project" });
    text = undefined; await showWorkerConfig(ctx, true);
    const display = JSON.parse(edited);
    assert.equal(display.defaultPreset, "minimal", "editing user defaults must not promote project overrides");
    assert.equal(display._effective.defaultPreset, "project");
    assert.equal(display._sources.length, 2);
    assert.deepEqual(options, ["User defaults", "Trusted project override"]);
    const before = readFileSync(projectFile, "utf8");
    scope = "Trusted project override"; await showWorkerConfig(ctx, true);
    assert.equal(readFileSync(projectFile, "utf8"), before, "editor cancellation preserves existing policy");
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    rmSync(root, { recursive: true, force: true });
  }
});
