import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { extensionInventory, selectExtensions } from "../src/settings/worker-extensions.ts";
import { workerConfiguration, saveWorkerConfiguration } from "../src/settings/config.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "at-extensions-"));
  const agent = join(root, "agent"), cwd = join(root, "project"), pkg = join(root, "pkg");
  for (const dir of [join(agent, "extensions"), join(cwd, ".pi", "extensions"), pkg]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", pi: { extensions: ["a.ts", "b.ts"] } }));
  for (const file of ["a.ts", "b.ts", "helper.ts"]) writeFileSync(join(pkg, file), "throw new Error('must not import');\n");
  writeFileSync(join(agent, "extensions", "guard.ts"), "throw new Error('must not import');\n");
  writeFileSync(join(cwd, ".pi", "extensions", "local.ts"), "throw new Error('must not import');\n");
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [{ source: pkg, extensions: ["a.ts"] }], extensions: ["-builtin:mcp"] }));
  return { root, agent, cwd, pkg, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("inventory does not import, honors filters/trust/builtins, and detects helper-only edits", async () => {
  const f = fixture();
  try {
    const untrusted = await extensionInventory(f.cwd, f.agent);
    assert.ok(untrusted.entries.some(e => e.id.includes("guard.ts") && e.enabled));
    assert.ok(!untrusted.entries.some(e => e.scope === "project" && e.enabled));
    new ProjectTrustStore(f.agent).set(f.cwd, true);
    const before = await extensionInventory(f.cwd, f.agent);
    assert.ok(before.entries.some(e => e.id.includes("local.ts") && e.enabled));
    assert.ok(before.entries.some(e => e.id.includes("a.ts") && e.enabled));
    assert.ok(before.entries.some(e => e.id.includes("b.ts") && !e.enabled));
    assert.equal(before.entries.find(e => e.id === "builtin:mcp")?.enabled, false);
    writeFileSync(join(f.pkg, "helper.ts"), "throw new Error('changed helper without entry/manifest edit');\n");
    const after = await extensionInventory(f.cwd, f.agent);
    assert.notEqual(after.fingerprint, before.fingerprint);
    assert.deepEqual(after.entries.map(e => e.id), before.entries.map(e => e.id));
    assert.deepEqual((await extensionInventory(f.cwd, f.agent)).fingerprint, after.fingerprint);
  } finally { f.close(); }
});

test("selection is explicit, protects requirements, pins IDs on resume, and fails closed", async () => {
  const f = fixture();
  try {
    const inventory = await extensionInventory(f.cwd, f.agent);
    const guard = inventory.entries.find(e => e.id.includes("guard.ts"))!.id;
    const a = inventory.entries.find(e => e.id.includes("a.ts"))!.id;
    const b = inventory.entries.find(e => e.id.includes("b.ts"))!.id;
    const config = { required: [guard], presets: { worker: { extensions: [] as string[], heapMb: 1536 }, full: { extensions: "all" as const } }, defaultPreset: "worker" };
    assert.equal(selectExtensions(inventory, undefined), undefined);
    assert.throws(() => selectExtensions(inventory, undefined, { preset: "missing" }), /Unknown.*preset/);
    const selected = selectExtensions(inventory, config, { include: [a] })!;
    assert.deepEqual(selected.ids, [guard, a].sort());
    assert.equal(selected.heapMb, 1536);
    assert.throws(() => selectExtensions(inventory, config, { exclude: [guard] }), /required/i);
    assert.throws(() => selectExtensions(inventory, config, { include: [b] }), /disabled|available/i);
    assert.throws(() => selectExtensions(inventory, config, { include: ["not-installed"] }), /available|Unknown/i);
    const resumed = selectExtensions(inventory, { ...config, defaultPreset: "full" }, undefined, selected)!;
    assert.deepEqual(resumed.ids, selected.ids);
    assert.equal(resumed.heapMb, 1536);
    const missing = { ...inventory, entries: inventory.entries.filter(e => e.id !== guard) };
    assert.throws(() => selectExtensions(missing, config, undefined, selected), /required/i);
    assert.throws(() => selectExtensions(inventory, { ...config, required: [guard, a] }, undefined, selectExtensions(inventory, config)!), /new launch|resume/i);
    const changed = { ...inventory, entries: inventory.entries.map(e => e.id === guard ? { ...e, fingerprint: "changed" } : e) };
    assert.ok(selectExtensions(changed, config, undefined, selected)!.warnings.some(w => w.includes("changed")));
  } finally { f.close(); }
});

test("worker config merges trusted project presets without weakening global requirements", () => {
  const f = fixture(), previous = process.env.HOME;
  process.env.HOME = f.root;
  try {
    const global = { required: ["guard"], defaultPreset: "worker", presets: { worker: { extensions: ["one"] } } };
    saveWorkerConfiguration(f.cwd, "user", global);
    saveWorkerConfiguration(f.cwd, "project", { required: ["auth"], presets: { worker: { extensions: ["two"] } } });
    assert.deepEqual(workerConfiguration(f.cwd, false).config, global);
    const effective = workerConfiguration(f.cwd, true);
    assert.deepEqual(effective.config?.required, ["guard", "auth"]);
    assert.deepEqual(effective.config?.presets.worker.extensions, ["two"]);
    assert.ok(effective.sources.length === 2);
    assert.throws(() => saveWorkerConfiguration(f.cwd, "user", { ...global, presets: { worker: { extensions: [], heapMb: 0 } } }), /Invalid/);
    assert.throws(() => saveWorkerConfiguration(f.cwd, "user", { ...global, defaultPreset: "missing" }), /preset/);
    writeFileSync(join(f.root, ".pi", "ac-teams", "config.json"), "{");
    assert.throws(() => saveWorkerConfiguration(f.cwd, "user", global), /Cannot read/);
  } finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; f.close(); }
});
