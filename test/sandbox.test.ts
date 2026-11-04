import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Coordinator, type CoordinatorOptions } from "../src/coordinator.ts";
import { maxSandboxed, memberImage, packageRoot, sandboxStatus } from "../src/access.ts";

const fixture = fileURLToPath(new URL("./fixtures/pi-peer.mjs", import.meta.url));
chmodSync(fixture, 0o755);
const piVersion = (() => { try { return JSON.parse(readFileSync(join(packageRoot(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()), "package.json"), "utf8")).version; } catch { return "missing"; } })();
const status = sandboxStatus(memberImage(piVersion));
// Real Docker isolation; skipped (never passed) where the daemon or member image is unavailable.
const skip = status.available ? false : status.reason;
const containers = (store: string) => execFileSync("docker", ["ps", "-aq", "--filter", `label=ac-teams.store=${store}`], { encoding: "utf8" }).trim();
const until = async (check: () => boolean, ms = 30000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("Condition timed out"); await new Promise(resolve => setTimeout(resolve, 100)); } };
const credentials = async () => ({ token: "REAL-SECRET", expires: Date.now() + 3600000 });
const hostAddresses = Object.values(networkInterfaces()).flat().filter(entry => entry && !entry.internal && !entry.address.startsWith("fe80")).map(entry => entry!.address);
const team = (root: string, cwd: string, extra: Partial<CoordinatorOptions> = {}) => Coordinator.open({
  id: randomUUID(), cwd, limit: 5, depth: 3, extension: fixture, command: fixture, home: join(root, "teams"), notice: () => {}, warning: () => {}, credentials, ...extra });

for (const interactive of [false, true]) {
  test(`enforced member cannot escape its grants (${interactive ? "native" : "RPC"})`, { skip, timeout: 180000 }, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sbx-")));
    const previous = { HOME: process.env.HOME, AC_TEAMS_TEST_SECRET: process.env.AC_TEAMS_TEST_SECRET, PI_LENS_WARM_ATTACH: process.env.PI_LENS_WARM_ATTACH };
    process.env.PI_LENS_WARM_ATTACH = "1";
    process.env.HOME = join(root, "home");
    process.env.AC_TEAMS_TEST_SECRET = "host-env-secret";
    const agentDir = join(root, "home/.pi/agent");
    // Main resumed from a member transcript: members must still nest under the original project directory.
    const mainSessions = join(agentDir, "sessions/--proj--/ac-teams/old-team/old-member");
    for (const dir of ["home/.pi/agent/sessions/--other--", mainSessions, "work/read", "work/write/.git/hooks"]) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: "REAL-SECRET", refresh: "REAL-REFRESH", expires: 1 }, openai: { type: "oauth", access: "OTHER-PROVIDER", refresh: "OTHER-REFRESH", expires: 1 } }));
    writeFileSync(join(agentDir, "sessions/--other--/other.jsonl"), "{}");
    writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [join(root, "work")]: true, "/elsewhere/project": true }));
    writeFileSync(join(agentDir, "web-search.json"), JSON.stringify({ exaApiKey: "SEARCH-KEY", proxy: "http://elsewhere:1" }));
    writeFileSync(join(root, "home/secret.txt"), "outside");
    writeFileSync(join(root, "work/read/file"), "readable");
    writeFileSync(join(root, "work/write/file"), "writable");
    const tcp = createTcpServer(socket => socket.end()).listen(0, "127.0.0.1");
    const unix = createTcpServer(socket => socket.end()).listen(join(root, "home/host.sock"));
    await Promise.all([once(tcp, "listening"), once(unix, "listening")]);
    let token = "REAL-SECRET";
    const t = await team(root, root, { interactive, home: join(root, "home/.pi/ac-teams/teams"), sessionDir: mainSessions, refreshMs: 200, credentials: async () => ({ token, expires: Date.now() + 3600000 }) });
    const store = t.store.dir;
    let left = "";
    try {
      const memberRoot = join(agentDir, "sessions/--proj--/ac-teams", t.store.state.id);
      const config = {
        outsideFile: join(root, "home/secret.txt"), readFile: join(root, "work/read/file"), readDir: join(root, "work/read"), writeFile: join(root, "work/write/file"),
        gitHook: join(root, "work/write/.git/hooks/pre-commit"), agentDir, otherTranscript: join(agentDir, "sessions/--other--/other.jsonl"), ownSessions: memberRoot,
        teamState: join(store, "state.json"), terminalSocket: join(store, "t.sock"), hostAddresses,
        hostPort: (tcp.address() as { port: number }).port, hostUnixSocket: join(root, "home/host.sock"), coordinatorPid: process.pid, model: "anthropic/claude-test",
      };
      const member = await t.handle("root", "agent", { action: "launch", name: "prober", model: "anthropic/claude-test", cwd: join(root, "work/write"),
        brief: "PROBE:" + JSON.stringify(config), access: { read: [join(root, "work/read")], write: ["."] } }) as { id: string; access: unknown };
      assert.deepEqual(member.access, { read: [join(root, "work/read")], write: [join(root, "work/write")], network: {} });
      let report: string | undefined;
      await until(() => !!(report = t.store.state.messages.find(message => message.from === member.id)?.summary), 120000);
      const r = JSON.parse(report!);
      assert.equal(r.readOutside.ok, false);
      assert.deepEqual(r.readGranted, { ok: true, value: "readable" });
      assert.equal(r.writeReadGrant.code, "EROFS");
      assert.equal(r.writeWriteGrant.ok, true);
      assert.equal(readFileSync(config.writeFile, "utf8"), "changed");
      assert.equal(statSync(config.writeFile).uid, process.getuid!());
      assert.equal(readFileSync(config.readFile, "utf8"), "readable");
      assert.equal(r.writeGitHook.ok, true);
      assert.equal(r.writeRoot.code, "EROFS");
      // Credentials: only the selected provider's current access token; no refresh token, no other provider.
      assert.deepEqual(Object.keys(r.authFile.value), ["anthropic"]);
      assert.equal(r.authFile.value.anthropic.access, "REAL-SECRET");
      assert.equal(r.authFile.value.anthropic.refresh, "");
      assert.doesNotMatch(JSON.stringify(r), /REAL-REFRESH|OTHER-PROVIDER|OTHER-REFRESH/);
      assert.deepEqual(r.webSearch.value, { exaApiKey: "SEARCH-KEY", proxy: "http://127.0.0.1:3128", ssrf: { trustEnvProxy: true } });
      assert.deepEqual(JSON.parse(r.trust.value), { [join(root, "work")]: true });
      assert.equal(r.sessionsListing.ok, true); // Only the mounted member transcript path exists inside.
      assert.deepEqual(r.sessionsListing.value, ["--proj--"]);
      assert.equal(r.otherTranscript.ok, false);
      assert.deepEqual(r.ownTranscripts, { ok: true, value: [member.id] });
      assert.equal(dirname(t.store.state.members[member.id].sessionFile!), join(memberRoot, member.id));
      assert.equal(r.teamState.ok, false);
      assert.equal(r.terminalSocket, false);
      assert.equal(r.dockerSocket, false);
      // Network: public HTTP and HTTPS through the proxy; host, private, and metadata addresses refused; nothing direct.
      assert.equal(r.publicHttps, "200");
      assert.equal(r.publicHttp, "200");
      assert.match(r.nodeProxyFetch, /^status 200/);
      for (const [target, result] of Object.entries(r.hostAddresses)) assert.match(result as string, /403/, target);
      assert.match(r.dockerBridge, /403/);
      assert.match(r.metadata, /403/);
      assert.equal(r.hostTcp.ok, false);
      assert.equal(r.internet.ok, false);
      assert.equal(r.hostUnixSocket.ok, false);
      assert.match(r.cleanNodeFetch, /^error (ENETUNREACH|EAI_AGAIN|ENOTFOUND|ECONNREFUSED)/);
      assert.match(r.udp, /^E[A-Z]+/);
      assert.match(r.startAgain, /409/, "the start gate cannot be replayed by member code");
      assert.equal(r.coordinatorVisible, false);
      assert.equal(r.killCoordinator.code, "ESRCH");
      assert.equal(r.capEff, "0000000000000000");
      assert.equal(r.capBnd, "0000000000000000");
      assert.equal(r.noNewPrivs, "1");
      assert.equal(r.uid, process.getuid!());
      assert.equal(r.unshareUser.error, undefined);
      assert.notEqual(r.unshareUser.status, 0);
      assert.equal(r.mount.error, undefined);
      assert.notEqual(r.mount.status, 0);
      // A native member's terminal is the container's own pty; injection, where the kernel allows it, stays inside.
      assert.doesNotMatch(r.tiocsti.out, /injected/);
      assert.match(r.tiocsti.out, interactive ? /^ioctl: / : /^open: /);
      if (interactive) assert.match(r.tty.value, /^\/dev\/pts\/\d+$/);
      assert.equal(r.hostSecretEnv, null);
      assert.equal(r.terminalSocketEnv, null);
      assert.equal(JSON.parse(r.accessEnv).enforced, true);
      assert.equal(r.warmAttachEnv, "0", "restricted members must not inherit host warm attach");
      assert.deepEqual(r.fds.filter((target: string) => !target.startsWith(memberRoot)), []);
      assert.match(r.escalate, /Write access .* exceeds/);
      assert.match(r.unsandboxedChild, /would expose|cwd must be inside|exceeds/);
      assert.match(r.userAction, /Sandboxed members cannot send user team actions/);
      assert.deepEqual(r.nested.access, { read: [join(root, "work/read")], write: [], network: { allow: [] } });
      assert.equal(dirname(t.store.state.members[r.nested.id].sessionFile!), join(memberRoot, r.nested.id));
      // The parent rewrites the member's token in place when it changes.
      const authFile = join(root, "home/.pi/ac-teams/agents", member.id, "auth.json");
      token = "ROTATED-SECRET";
      await until(() => readFileSync(authFile, "utf8").includes("ROTATED-SECRET"), 10000);
      const name = `ac-teams-${t.store.state.id}-${member.id}`;
      assert.match(execFileSync("docker", ["exec", name, "cat", join(agentDir, "auth.json")], { encoding: "utf8" }), /ROTATED-SECRET/);
      const inspect = JSON.parse(execFileSync("docker", ["inspect", name], { encoding: "utf8" }))[0];
      assert.equal(inspect.HostConfig.NetworkMode, "none");
      assert.deepEqual(inspect.NetworkSettings.Ports ?? {}, {});
      assert.match(execFileSync("docker", ["exec", name, "cat", "/proc/net/dev"], { encoding: "utf8" }).split("\n").slice(2).filter(Boolean).map(line => line.trim().split(":")[0]).join(","), /^lo$/);
    } finally {
      await t.close(); tcp.close(); unix.close();
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      left = containers(store);
      assert.equal(existsSync(join(root, "home/.pi/ac-teams/agents")) ? readdirSync(join(root, "home/.pi/ac-teams/agents")).length : 0, 0, "member credentials are removed");
      rmSync(root, { recursive: true, force: true });
    }
    assert.equal(left, "", "containers are removed when the team closes");
  });
}

test("a second owner cannot remove live members, and the next owner removes orphans of a killed coordinator", { skip, timeout: 120000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sbo-")));
  const home = join(root, "teams"), id = randomUUID();
  mkdirSync(join(root, "work"));
  const owner = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./fixtures/sandbox-owner.ts", import.meta.url)), id, home, join(root, "work"), fixture], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const [line] = await once(owner.stdout, "data") as [Buffer];
    const { dir } = JSON.parse(line.toString());
    assert.notEqual(containers(dir), "");
    const options = { id, cwd: join(root, "work"), limit: 3, depth: 2, extension: fixture, command: fixture, home, notice: () => {}, warning: () => {}, credentials };
    await assert.rejects(Coordinator.open(options), /live owner/);
    assert.notEqual(containers(dir), "", "a refused second owner leaves live containers alone");
    owner.kill("SIGKILL");
    await once(owner, "exit");
    // Pi sees stdin close and exits; the stopped container stays behind for the next owner.
    await until(() => execFileSync("docker", ["ps", "-q", "--filter", `label=ac-teams.store=${dir}`], { encoding: "utf8" }).trim() === "");
    // Let the attached docker CLI exit too.
    const name = execFileSync("docker", ["inspect", "--format", "{{.Name}}", containers(dir)], { encoding: "utf8" }).trim().slice(1);
    await until(() => spawnSync("pgrep", ["-f", `docker start --attach --interactive ${name}$`]).status === 1);
    assert.notEqual(containers(dir), "", "killing the coordinator orphans the container");
    const next = await Coordinator.open(options);
    try { assert.equal(containers(dir), "", "the next owner removes the orphan"); }
    finally { await next.close(); }
  } finally { owner.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); }
});

test("the enforced-member cap counts containers from every coordinator on the host", { skip, timeout: 120000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sbc-")));
  mkdirSync(join(root, "work"));
  const image = memberImage(piVersion).tag, label = `ac-teams.store=${join(root, "other-team")}`;
  // Stand-ins for other teams' members: created, never started, no network.
  let t: Coordinator | undefined;
  try {
    for (let index = 0; index < maxSandboxed(); index++) execFileSync("docker", ["create", "--network", "none", "--label", "ac-teams.member=other", "--label", label, image, "true"]);
    t = await team(root, join(root, "work"));
    await assert.rejects(t.handle("root", "agent", { action: "launch", name: "over", model: "anthropic/claude-test", brief: "x", access: { read: ["."] } }), /At most \d+ enforced members/);
    assert.equal(containers(t.store.dir), "", "the refused container is removed");
  } finally {
    await t?.close();
    const others = containers(join(root, "other-team")).split("\n").filter(Boolean);
    if (others.length) execFileSync("docker", ["rm", "-f", ...others]);
    rmSync(root, { recursive: true, force: true });
  }
});

for (const interactive of [false, true]) test(`a grant swapped for a symlink after the checks is caught before any member code runs (${interactive ? "native" : "RPC"})`, { skip, timeout: 120000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sbs-")));
  for (const dir of ["repo/src", "secret"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "secret/key"), "secret");
  const image = memberImage(piVersion).tag;
  // The attack primitive, deterministically: Docker resolves a bind source when the container starts, not when it is created.
  const probe = execFileSync("docker", ["create", "--network", "none", "--mount", `type=bind,source=${join(root, "repo/src")},target=/data,readonly`, image, "cat", "/data/key"], { encoding: "utf8" }).trim();
  rmSync(join(root, "repo/src"), { recursive: true });
  symlinkSync(join(root, "secret"), join(root, "repo/src"));
  assert.equal(execFileSync("docker", ["start", "--attach", probe], { encoding: "utf8" }), "secret");
  execFileSync("docker", ["rm", "-f", probe]);
  rmSync(join(root, "repo/src")); mkdirSync(join(root, "repo/src"));
  // ac-teams: a writer swaps the reader's grant after every pre-start check (test hook), so Docker mounts secret/.
  const sessions = join(root, "sessions");
  const t = await team(root, join(root, "repo/src"), { interactive, sessionDir: sessions, beforeStart: async () => { rmSync(join(root, "repo/src"), { recursive: true }); symlinkSync(join(root, "secret"), join(root, "repo/src")); } });
  try {
    await assert.rejects(t.handle("root", "agent", { action: "launch", name: "reader", model: "anthropic/claude-test", brief: "x", access: { read: ["."] } }), /is not the directory that was checked/);
    assert.equal(containers(t.store.dir), "", "the container is removed");
    // The member never ran: Pi would have created a transcript.
    const member = Object.values(t.store.state.members).find(m => m.name === "reader")!;
    assert.equal(member.sessionId, undefined);
    assert.deepEqual(readdirSync(join(sessions, "ac-teams", t.store.state.id, member.id)), []);
  } finally { await t.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an ordinary writer of a repo and a reader of its subdirectory run together", { skip, timeout: 180000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sbw-")));
  mkdirSync(join(root, "repo/src"), { recursive: true });
  const writers = await team(root, join(root, "repo")), readers = await team(root, join(root, "repo/src"));
  try {
    await writers.handle("root", "agent", { action: "launch", name: "writer", model: "anthropic/claude-test", brief: "WAIT", access: { write: ["."] } });
    await readers.handle("root", "agent", { action: "launch", name: "reader", model: "anthropic/claude-test", brief: "WAIT", access: { read: ["."] } });
    assert.notEqual(containers(writers.store.dir), "");
    assert.notEqual(containers(readers.store.dir), "");
  } finally { await writers.close(); await readers.close(); rmSync(root, { recursive: true, force: true }); }
});

test("runtime mounts cannot sit inside another member's writable grant", { skip, timeout: 120000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sbr-")));
  mkdirSync(join(root, "work"));
  const image = memberImage(piVersion).tag, runtimeParent = dirname(packageRoot(fixture));
  // Another team's member with write access to the directory containing this package (created, never started).
  const other = execFileSync("docker", ["create", "--network", "none", "--label", "ac-teams.member=other", "--label", `ac-teams.store=${join(root, "other")}`,
    "--label", `ac-teams.grants=${JSON.stringify([runtimeParent])}`, "--mount", `type=bind,source=${runtimeParent},target=/x`, image, "true"], { encoding: "utf8" }).trim();
  const t = await team(root, join(root, "work"));
  try {
    await assert.rejects(t.handle("root", "agent", { action: "launch", name: "inner", model: "anthropic/claude-test", brief: "x", access: { read: ["."] } }), /strictly inside a sandboxed member's writable directory/);
    assert.equal(containers(t.store.dir), "");
  } finally { await t.close(); execFileSync("docker", ["rm", "-f", other]); rmSync(root, { recursive: true, force: true }); }
});

test("a resumed enforced member gets a new container that passes the same gate", { skip, timeout: 180000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sbm-")));
  mkdirSync(join(root, "work"));
  const t = await team(root, join(root, "work"));
  try {
    const member = await t.handle("root", "agent", { action: "launch", name: "again", model: "anthropic/claude-test", brief: "WAIT", access: { read: ["."] } }) as { id: string };
    const first = containers(t.store.dir);
    await t.handle("root", "agent", { action: "stop", id: member.id });
    assert.equal(containers(t.store.dir), "");
    const resumed = await t.handle("root", "agent", { action: "resume", id: member.id, model: "anthropic/claude-test", brief: "WAIT" }) as { status: string; access: unknown };
    assert.notEqual(containers(t.store.dir), "");
    assert.notEqual(containers(t.store.dir), first);
    assert.deepEqual(resumed.access, { read: [join(root, "work")], write: [], network: {} });
  } finally { await t.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a member with restricted network access cannot switch its descendants or its resume to another provider", { skip, timeout: 180000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sbp-")));
  mkdirSync(join(root, "work"));
  const t = await team(root, join(root, "work"));
  try {
    const member = await t.handle("root", "agent", { action: "launch", name: "narrow", model: "anthropic/claude-test", brief: "WAIT", access: { read: ["."], network: { allow: [] } } }) as { id: string };
    await assert.rejects(t.handle(member.id, "agent", { action: "launch", name: "switch", model: "openai/gpt-test", brief: "x" }), /can only use anthropic models/);
    await t.handle("root", "agent", { action: "stop", id: member.id });
    await assert.rejects(t.handle("root", "agent", { action: "resume", id: member.id, model: "openai/gpt-test", brief: "x" }), /can only use anthropic models/);
  } finally { await t.close(); rmSync(root, { recursive: true, force: true }); }
});
