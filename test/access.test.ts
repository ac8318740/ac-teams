import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertNarrower, assertStableGrants, mountSet, containerProblems, dockerCreateArgs, memberMemory, resolveAccess, sandboxMounts, type SandboxPlan } from "../src/access.ts";

function tree() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acc-")));
  for (const dir of ["repo/src", "docs", "outside"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "file"), "x");
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("grants resolve to canonical directories and write implies read", () => {
  const t = tree();
  try {
    const access = resolveAccess({ read: ["docs", join(t.root, "repo/src"), "docs/"], write: ["repo"] }, t.root);
    assert.deepEqual(access, { read: [join(t.root, "docs")], write: [join(t.root, "repo")], network: {} });
    assert.throws(() => resolveAccess({ read: ["missing"] }, t.root), /does not exist/);
    assert.throws(() => resolveAccess({ read: ["file"] }, t.root), /must be a directory/);
    mkdirSync(join(t.root, "real,readonly=false"));
    assert.throws(() => resolveAccess({ read: ["real,readonly=false"] }, t.root), /commas/);
    for (const path of ["/", "/tmp", "/proc", "/dev/shm", "/run", homedir(), dirname(homedir()), join(homedir(), ".pi")]) assert.throws(() => resolveAccess({ read: [path] }, t.root), /not allowed|would expose/, path);
    if (existsSync(join(homedir(), ".pi/agent/sessions"))) assert.throws(() => resolveAccess({ read: [join(homedir(), ".pi/agent/sessions")] }, t.root), /private Pi or ac-teams state/);
  } finally { t.close(); }
});

test("children can only narrow access, and symlinks resolve before the check", () => {
  const t = tree();
  try {
    const parent = resolveAccess({ read: ["docs"], write: ["repo"] }, t.root);
    assertNarrower(undefined, undefined);
    assertNarrower(undefined, parent);
    assertNarrower(parent, resolveAccess({ read: ["repo/src", "docs"] }, t.root));
    assertNarrower(parent, resolveAccess({ write: ["repo/src"] }, t.root));
    assert.throws(() => assertNarrower(parent, undefined), /cannot launch or resume an unsandboxed/);
    assert.throws(() => assertNarrower(parent, resolveAccess({ write: ["docs"] }, t.root)), /Write access/);
    assert.throws(() => assertNarrower(parent, resolveAccess({ read: ["outside"] }, t.root)), /Read access/);
    assert.throws(() => assertNarrower(parent, resolveAccess({ read: [t.root] }, t.root)), /Read access/);
    symlinkSync(join(t.root, "outside"), join(t.root, "repo", "escape"));
    // Symlinked spellings are refused outright: Docker would resolve them again at start, after any check.
    assert.throws(() => resolveAccess({ read: ["repo/escape"] }, t.root), /canonical, without symlinks/);
  } finally { t.close(); }
});

test("mounts below a sandboxed writer's directory are refused to avoid symlink swaps; grants themselves are identity-checked", () => {
  const t = tree();
  try {
    const repo = join(t.root, "repo"), src = join(repo, "src"), runtime = join(src, "runtime");
    const writer = mountSet([{ source: repo, rw: true }], [repo]);
    // A reader's grant inside the writer's directory is pinned by the start check, so it runs alongside.
    assertStableGrants(mountSet([{ source: src, rw: false }], [src]), [writer]);
    // Any other mount (runtime, transcripts, sockets) inside another member's writable directory is refused, in either launch order.
    const reader = mountSet([{ source: src, rw: false }, { source: runtime, rw: false }], [src]);
    assert.throws(() => assertStableGrants(reader, [writer]), /strictly inside a sandboxed member's writable directory/);
    assert.throws(() => assertStableGrants(writer, [reader]), /strictly inside/);
    // A member's own runtime inside its own writable directory is refused: it could swap the bridge before its next start.
    assert.throws(() => assertStableGrants(mountSet([{ source: repo, rw: true }, { source: join(repo, "node_modules/ac-teams"), rw: false }], [repo]), []), /strictly inside/);
  } finally { t.close(); }
});

function plan(t: { root: string }, terminal = false): SandboxPlan {
  return {
    name: "ac-teams-t-m", labels: { "ac-teams.team": "t", "ac-teams.member": "m" }, image: "ac-teams-member:test",
    access: resolveAccess({ read: ["docs"], write: ["repo"] }, t.root), cwd: join(t.root, "repo"), home: "/home/user", terminal,
    agentDir: "/home/user/.pi/agent", configDir: "/home/user/.pi/ac-teams/agents/m", sessionDir: "/home/user/.pi/agent/sessions/k/ac-teams/t/m",
    coordinatorSocket: "/home/user/.pi/ac-teams/teams/t/coordinator.sock", egressSocket: "/home/user/.pi/ac-teams/teams/t/e-m.sock",
    runtime: ["/opt/ac-teams"], launch: "/home/user/.pi/ac-teams/agents/m/launch.json", bridge: "/opt/ac-teams/src/sandbox-bridge.mjs",
  };
}

test("member containers get no network, ports, capabilities, or restart, and carry no secrets", () => {
  const t = tree();
  try {
    const p = plan(t), args = dockerCreateArgs(p), joined = args.join(" ");
    for (const flag of ["--network none", "--cap-drop ALL", "--security-opt no-new-privileges", "--read-only", "--restart no", "--log-driver none", "--init"]) assert.ok(joined.includes(flag), flag);
    assert.ok(!/(^| )(-p|--publish|--publish-all|--privileged|--cap-add|--net(work)?=host|--pid|--ipc|--volume|-v) /.test(joined));
    assert.ok(!/docker\.sock|token|secret|sk-ant/i.test(joined));
    assert.ok(args.includes("--interactive") && !args.includes("--tty"));
    assert.ok(dockerCreateArgs(plan(t, true)).includes("--tty"));
    assert.deepEqual(args.slice(-4), ["ac-teams-member:test", "node", p.bridge, p.launch]);
    // Only these host paths are mounted; Pi's real auth.json is replaced by the generated placeholder.
    const mounts = sandboxMounts(p);
    assert.ok(mounts.some(m => m.source === join(t.root, "docs") && m.readonly));
    assert.ok(mounts.some(m => m.source === join(t.root, "repo") && !m.readonly));
    assert.ok(mounts.some(m => m.source === "/home/user/.pi/ac-teams/agents/m/auth.json" && m.target === "/home/user/.pi/agent/auth.json" && m.readonly));
    assert.ok(!mounts.some(m => /sessions$|\/teams\/t$|t\.sock$|\.pi\/ac-teams$/.test(m.source)));
  } finally { t.close(); }
});

test("the inspect check rejects any drift from the container policy", () => {
  const t = tree();
  try {
    const p = plan(t), uid = process.getuid!(), gid = process.getgid!();
    const good = () => ({
      HostConfig: { NetworkMode: "none", PortBindings: {}, PublishAllPorts: false, Privileged: false, CapDrop: ["ALL"], CapAdd: null, SecurityOpt: ["no-new-privileges"], ReadonlyRootfs: true,
        RestartPolicy: { Name: "no" }, LogConfig: { Type: "none" }, PidMode: "", IpcMode: "private", UTSMode: "", UsernsMode: "", CgroupnsMode: "private", Devices: [], GroupAdd: null,
        Memory: memberMemory, PidsLimit: 1024, Tmpfs: { "/tmp": "", "/home/user": "", "/home/user/.pi/agent": "" } },
      Config: { User: `${uid}:${gid}`, ExposedPorts: null, Volumes: null },
      Mounts: sandboxMounts(p).map(m => ({ Type: "bind", Source: m.source, Destination: m.target, RW: !m.readonly })),
      NetworkSettings: { Ports: {} },
    });
    assert.deepEqual(containerProblems(good(), p, true), []);
    const drift: [string, (c: any) => void][] = [
      ["host network", c => { c.HostConfig.NetworkMode = "host"; }],
      ["published port", c => { c.HostConfig.PortBindings = { "80/tcp": [{ HostPort: "80" }] }; }],
      ["bound after start", c => { c.NetworkSettings.Ports = { "80/tcp": null }; }],
      ["capability", c => { c.HostConfig.CapAdd = ["NET_ADMIN"]; }],
      ["privileged", c => { c.HostConfig.Privileged = true; }],
      ["new privileges", c => { c.HostConfig.SecurityOpt = []; }],
      ["writable root", c => { c.HostConfig.ReadonlyRootfs = false; }],
      ["restart", c => { c.HostConfig.RestartPolicy = { Name: "always" }; }],
      ["host pid", c => { c.HostConfig.PidMode = "host"; }],
      ["root user", c => { c.Config.User = "0:0"; }],
      ["image volume", c => { c.Config.Volumes = { "/data": {} }; c.Mounts.push({ Type: "volume", Source: "/var/lib/docker/volumes/x", Destination: "/data", RW: true }); }],
      ["docker socket", c => { c.Mounts.push({ Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock", RW: true }); }],
      ["writable grant flipped", c => { c.Mounts.find((m: any) => m.Source === join(t.root, "docs")).RW = true; }],
      ["extra tmpfs", c => { c.HostConfig.Tmpfs["/run"] = ""; }],
      ["device", c => { c.HostConfig.Devices = [{ PathOnHost: "/dev/kvm" }]; }],
      ["seccomp off", c => { c.HostConfig.SecurityOpt = ["no-new-privileges", "seccomp=unconfined"]; }],
    ];
    for (const [name, change] of drift) { const c = good(); change(c); assert.notDeepEqual(containerProblems(c, p, true), [], name); }
  } finally { t.close(); }
});
