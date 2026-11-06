import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { configureWorker, workerConfigPrompt } from "../src/ui/worker-config.ts";
import { extensionInventory } from "../src/settings/worker-extensions.ts";
import { saveWorkerConfiguration, workerConfiguration } from "../src/settings/config.ts";

test("Pi-led configuration discovers inventory and saves only validated, confirmed policies", async () => {
  const root = mkdtempSync(join(tmpdir(), "at-worker-ui-")), cwd = join(root, "project"), agent = join(root, "agent");
  const oldHome = process.env.HOME, oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = root; process.env.PI_CODING_AGENT_DIR = agent;
  mkdirSync(join(agent, "extensions"), { recursive: true }); mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
  const guard = join(agent, "extensions", "guard.ts");
  writeFileSync(guard, "throw new Error('inventory must not import');");
  let confirmed = false, summary = "", confirmations = 0;
  const ctx = { cwd, mode: "tui", isProjectTrusted: () => true, ui: {
    select: async () => { assert.fail("Configuration must not open a menu wizard"); },
    input: async () => { assert.fail("Pi must ask questions in conversation"); },
    editor: async () => { assert.fail("Configuration must never open an editor"); },
    confirm: async (_title: string, message: string) => { confirmations++; summary = message; return confirmed; },
  } } as unknown as ExtensionContext;
  const run = (args: Parameters<typeof configureWorker>[3], project = false) => configureWorker(ctx, project, () => extensionInventory(cwd, agent, [guard]), args);
  const userFile = join(root, ".pi", "ac-teams", "config.json"), projectFile = join(cwd, ".pi", "ac-teams.json");
  try {
    assert.match(workerConfigPrompt, /available question tool.*otherwise ask in chat/);
    assert.match(workerConfigPrompt, /get my approval before calling team_config/);
    const read = await run({ action: "read" }, true);
    assert.ok("inventory" in read);
    assert.equal(read.projectAllowed, false, "native saved trust is required despite a trusted caller");
    const id = read.inventory.find(entry => entry.id.includes("guard.ts"))!.id;
    assert.equal(read.inventory.find(entry => entry.id === id)!.parentLoaded, true);
    assert.equal(read.suggested.defaultPreset, "worker");
    assert.deepEqual(read.suggested.presets.worker.extensions, [id]);
    assert.ok(!existsSync(userFile), "starting the conversation changes nothing");
    const workers = { defaultPreset: "lean", required: [id], presets: { lean: { extensions: [], heapMb: 1536 }, full: { extensions: "all" } } };
    await assert.rejects(run({ action: "save", workers }), /Choose user or project scope/);
    await assert.rejects(run({ action: "save", scope: "project", workers }, true), /native Pi project trust/);
    await assert.rejects(run({ action: "save", scope: "user", workers: { ...workers, defaultPreset: "missing" } }), /Invalid default/);
    await assert.rejects(run({ action: "save", scope: "user", workers: { ...workers, presets: { bad: { extensions: [], heapMb: 127 } } } }), /Invalid worker preset/);
    assert.equal(confirmations, 0, "invalid policies are rejected before confirmation");
    assert.deepEqual(await run({ action: "save", scope: "user", workers }), { saved: false });
    assert.ok(!existsSync(userFile));
    confirmed = true;
    assert.equal((await run({ action: "save", scope: "user", workers })).saved, true);
    assert.equal(statSync(userFile).mode & 0o777, 0o600);
    assert.ok(summary.includes(`Required: ${id}`));
    assert.ok(summary.includes("Default: lean"));
    assert.ok(summary.includes("heap 1536 MB"));
    assert.ok(summary.includes("resumes keep saved IDs"));
    assert.ok(workerConfiguration(cwd, false).config?.reviewed?.[cwd]);
    assert.equal(Object.hasOwn(workers, "reviewed"), false, "saving does not mutate the proposed policy");
    const before = readFileSync(userFile, "utf8");
    confirmed = false;
    await run({ action: "save", scope: "user", workers: { ...workers, required: [] } });
    assert.equal(readFileSync(userFile, "utf8"), before, "cancellation preserves existing policy");
    new ProjectTrustStore(agent).set(cwd, true);
    saveWorkerConfiguration(cwd, "project", { required: [], presets: { project: { extensions: [] } }, defaultPreset: "project" });
    const projectRead = await run({ action: "read" }, true);
    assert.ok("user" in projectRead);
    assert.equal(projectRead.projectAllowed, true);
    assert.equal(projectRead.user.config?.defaultPreset, "lean");
    assert.equal(projectRead.effective.config?.defaultPreset, "project");
    assert.deepEqual(projectRead.effective.sources, [userFile, projectFile]);
    confirmed = true;
    await run({ action: "save", scope: "project", workers: { required: [], presets: { project: { extensions: [] } }, defaultPreset: "project" } }, true);
    assert.deepEqual(workerConfiguration(cwd, true).config!.required, [id], "project settings cannot weaken inherited requirements");
    assert.equal(readFileSync(userFile, "utf8"), before, "saving project policy does not promote it into user defaults");
    const legacy = { required: ["missing:safety"], presets: { legacy: { extensions: ["missing:optional"], heapMb: 2048 } }, defaultPreset: "legacy" };
    await run({ action: "save", scope: "user", workers: legacy });
    assert.deepEqual(workerConfiguration(cwd, false).config!.presets, legacy.presets, "missing saved IDs are not silently removed");
    assert.deepEqual(workerConfiguration(cwd, false).config!.required, legacy.required);
    await assert.rejects(configureWorker({ ...ctx, mode: "rpc" }, false, () => extensionInventory(cwd, agent, [guard]), { action: "save", scope: "user", workers }), /interactive terminal/);
    writeFileSync(userFile, "{");
    await assert.rejects(run({ action: "read" }), /Cannot read team policy/);
    await assert.rejects(run({ action: "save", scope: "user", workers }), /Cannot read team policy/);
    assert.equal(readFileSync(userFile, "utf8"), "{");
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
    rmSync(root, { recursive: true, force: true });
  }
});
