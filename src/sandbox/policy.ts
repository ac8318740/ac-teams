import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { stateRoot } from "../settings/config.ts";
import { assertNetworkNarrower, validatePolicy, type NetworkPolicy } from "./egress.ts";
import { dirname, join, resolve } from "node:path";

/** Canonical directory grants; write implies read. Undefined access means an unsandboxed member. */
export interface Access { read: string[]; write: string[]; network: NetworkPolicy }
export interface AccessRequest { read?: string[]; write?: string[]; network?: NetworkPolicy }
export interface SandboxStatus { available: boolean; backend: "docker"; reason?: string }

export const within = (path: string, root: string) => path === root || path.startsWith(root === "/" ? "/" : root + "/");
const inside = (path: string, roots: string[]) => roots.some(root => within(path, root));
export const readable = (access: Access, path: string) => inside(path, [...access.read, ...access.write]);
export const writable = (access: Access, path: string) => inside(path, access.write);

/** Pi's agent directory and ac-teams state hold credentials, transcripts, and coordinator tokens. */
export const privateRoots = () => [resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")), stateRoot()];

export function resolveAccess(request: AccessRequest, base: string): Access {
  const canonical = (paths: string[] = []) => [...new Set(paths.map(path => {
    let real: string;
    try { real = realpathSync(resolve(base, path)); } catch { throw new Error(`Access path does not exist: ${path}`); }
    if (!statSync(real).isDirectory()) throw new Error(`Access path must be a directory: ${path}`);
    // A symlink in the path would be re-resolved by Docker at start; a sandboxed writer could have planted or could swap it.
    if (real !== resolve(base, path)) throw new Error(`Access paths must be canonical, without symlinks: ${path} resolves to ${real}`);
    // Docker's --mount syntax has no escaping, so a comma would inject mount options.
    if (/[,\n]/.test(real)) throw new Error(`Access paths cannot contain commas or newlines: ${real}`);
    // These would replace the sandbox's private /proc, /dev, /tmp, or home, or expose host sockets and credentials.
    for (const unsafe of ["/proc", "/dev", "/sys", "/run"]) if (within(real, unsafe)) throw new Error(`Access to ${real} is not allowed`);
    for (const covered of ["/tmp", "/run", "/var/run", homedir()]) if (within(covered, real)) throw new Error(`Access to ${real} would expose ${covered}; grant a narrower directory`);
    for (const root of privateRoots()) if (within(real, root) || within(root, real)) throw new Error(`Access to ${real} would expose private Pi or ac-teams state in ${root}`);
    return real;
  }))].sort();
  const write = canonical(request.write);
  return { read: canonical(request.read).filter(path => !inside(path, write)), write, network: validatePolicy(request.network ?? {}) };
}

/** Throws unless child grants are the same as or narrower than the actor's; an unsandboxed actor may grant anything. */
export function assertNarrower(actor: Access | undefined, child: Access | undefined): void {
  if (!actor) return;
  if (!child) throw new Error("A sandboxed member cannot launch or resume an unsandboxed member");
  for (const path of child.write) if (!writable(actor, path)) throw new Error(`Write access to ${path} exceeds the requesting member's access`);
  for (const path of child.read) if (!readable(actor, path)) throw new Error(`Read access to ${path} exceeds the requesting member's access`);
  assertNetworkNarrower(actor.network, child.network);
}

/** Host paths a member mounts, and the subset it can write. */
export interface MountSet { sources: string[]; writes: string[] }
/** Grants are identity-checked at start, so only a member's other mounts count as sources; its writable grants are its writes. */
export const mountSet = (mounts: { source: string; rw: boolean }[], grants: string[]): MountSet => ({
  sources: mounts.filter(mount => !grants.includes(mount.source)).map(mount => mount.source),
  writes: mounts.filter(mount => mount.rw && grants.includes(mount.source)).map(mount => mount.source) });
/**
 * Docker resolves bind sources when a container starts. A sandboxed writer can replace any entry strictly below its
 * writable directory, so no member may mount a path strictly inside another live member's writable directory, in either
 * direction. Equal paths are safe: a writer cannot replace its own mount point. A member's own non-grant mounts (runtime,
 * bridge) must not sit inside its own writable directory either, or it could swap them before its next start.
 */
export function assertStableGrants(mine: MountSet, others: MountSet[]): void {
  const below = (set: MountSet, writer: MountSet) => set.sources.find(path => writer.writes.some(root => path !== root && within(path, root)));
  for (const other of [...others, mine]) {
    const path = below(mine, other) ?? below(other, mine);
    if (path) throw new Error(`Mount ${path} lies strictly inside a sandboxed member's writable directory; grant that directory or a path outside it`);
  }
}

/** Pi agent-directory entries members need: installed packages, extensions, themes, skills, prompts, and settings Pi reads at startup. */
export const agentRuntime = ["npm", "extensions", "themes", "skills", "prompts", "AGENTS.md", "keybindings.json", "acstack.json", "models-store.json"];
export const generatedAgentFiles = ["settings.json", "auth.json", "trust.json", "web-search.json"];

export function packageRoot(file: string): string {
  for (let dir = dirname(realpathSync(file)); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) return dir;
    if (dir === dirname(dir)) throw new Error(`No package root for ${file}`);
  }
}

// Container memory caps; the aggregate guard keeps the sum of caps within 75% of host RAM.
// shortcut: fixed per-member cap, add a setting if real workloads need more.
export const memberMemory = 2 * 1024 ** 3;
export const memberPids = 1024;
export const maxSandboxed = () => Math.max(1, Math.floor(totalmem() * 0.75 / memberMemory));

const dockerfile = new URL("./member.Dockerfile", import.meta.url);
/** Image tag tied to the host Pi version and this Dockerfile, so members run the same Pi as Main. */
export function memberImage(piVersion: string): { tag: string; build: string } {
  const hash = createHash("sha256").update(readFileSync(dockerfile)).digest("hex").slice(0, 12);
  const tag = `ac-teams-member:${piVersion}-${hash}`, file = fileURLToPath(dockerfile);
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  return { tag, build: `docker build -t ${quote(tag)} --build-arg ${quote(`PI_VERSION=${piVersion}`)} -f ${quote(file)} ${quote(dirname(file))}` };
}

export function sandboxStatus(image: { tag: string; build: string }, docker = "docker"): SandboxStatus {
  const status = (reason?: string): SandboxStatus => ({ available: !reason, backend: "docker", ...(reason ? { reason } : {}) });
  if (process.platform !== "linux") return status("Enforced access requires Linux");
  const probe = spawnSync(docker, ["image", "inspect", "--format", "{{json .Config.Volumes}}", image.tag], { encoding: "utf8", timeout: 10000 });
  if (probe.error) return status(`Docker is unavailable: ${probe.error.message}`);
  if (probe.status !== 0) return status(/No such image/i.test(probe.stderr) ? `Member image ${image.tag} is missing; build it with: ${image.build}` : `Docker cannot be used: ${probe.stderr.trim().slice(0, 300)}`);
  if (!["null", "{}"].includes(probe.stdout.trim())) return status(`Member image ${image.tag} declares volumes; rebuild it from the shipped Dockerfile`);
  return status();
}

export interface SandboxPlan {
  name: string; labels: Record<string, string>; image: string; access: Access; cwd: string; home: string; terminal: boolean;
  agentDir: string; configDir: string; sessionDir: string; coordinatorSocket: string; egressSocket: string;
  runtime: string[]; launch: string; bridge: string;
}
export interface Mount { source: string; target: string; readonly: boolean }
/** Every host path a member container sees. Nothing else on the host is mounted. */
export function sandboxMounts(plan: SandboxPlan): Mount[] {
  const mounts: Mount[] = [
    ...plan.access.read.map(path => ({ source: path, target: path, readonly: true })),
    ...plan.access.write.map(path => ({ source: path, target: path, readonly: false })),
    // Runtime code stays read-only even inside a writable grant, because unsandboxed processes load it too.
    ...plan.runtime.map(path => ({ source: path, target: path, readonly: true })),
    ...agentRuntime.map(name => join(plan.agentDir, name)).filter(path => existsSync(path)).map(path => ({ source: path, target: path, readonly: true })),
    ...generatedAgentFiles.map(name => ({ source: join(plan.configDir, name), target: join(plan.agentDir, name), readonly: true })),
    { source: plan.launch, target: plan.launch, readonly: true },
    { source: plan.sessionDir, target: plan.sessionDir, readonly: false },
    { source: plan.coordinatorSocket, target: plan.coordinatorSocket, readonly: false },
    { source: plan.egressSocket, target: plan.egressSocket, readonly: false },
  ];
  return mounts;
}

export function dockerCreateArgs(plan: SandboxPlan): string[] {
  const uid = process.getuid!(), gid = process.getgid!();
  const args = ["create", "--name", plan.name, "--interactive", ...(plan.terminal ? ["--tty"] : []), "--init",
    "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--restart", "no",
    "--user", `${uid}:${gid}`, "--memory", String(memberMemory), "--memory-swap", String(memberMemory), "--pids-limit", String(memberPids),
    "--log-driver", "none", "--hostname", "ac-teams",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m", "--tmpfs", `${plan.home}:rw,nosuid,nodev,size=256m,uid=${uid},gid=${gid},mode=0700`,
    // Pi writes lock files and caches in its agent directory; this private scratch copy hides the real one.
    "--tmpfs", `${plan.agentDir}:rw,nosuid,nodev,size=64m,uid=${uid},gid=${gid},mode=0700`];
  for (const [key, value] of Object.entries(plan.labels)) args.push("--label", `${key}=${value}`);
  // Other coordinators use this to tell grants (identity-checked at start) from runtime mounts.
  args.push("--label", `ac-teams.grants=${JSON.stringify([...plan.access.read, ...plan.access.write])}`);
  for (const mount of sandboxMounts(plan)) args.push("--mount", `type=bind,source=${mount.source},target=${mount.target}${mount.readonly ? ",readonly" : ""}`);
  args.push("--env", "PATH=/usr/local/bin:/usr/bin:/bin", "--env", `HOME=${plan.home}`, "--env", "TMPDIR=/tmp",
    "--workdir", plan.cwd, plan.image, "node", plan.bridge, plan.launch);
  return args;
}

/** Checks docker inspect output against the policy; any problem means the container must not start. */
export function containerProblems(inspect: any, plan: SandboxPlan, started = false): string[] {
  const problems: string[] = [], host = inspect?.HostConfig ?? {}, config = inspect?.Config ?? {};
  const expect = (ok: boolean, problem: string) => { if (!ok) problems.push(problem); };
  expect(host.NetworkMode === "none", `network mode ${host.NetworkMode}`);
  expect(!Object.keys(host.PortBindings ?? {}).length && !host.PublishAllPorts && !Object.keys(config.ExposedPorts ?? {}).length, "ports are published or exposed");
  expect(host.Privileged === false, "privileged");
  expect(JSON.stringify(host.CapDrop) === '["ALL"]' && !(host.CapAdd ?? []).length, "capabilities are not all dropped");
  const security: string[] = host.SecurityOpt ?? [];
  expect(security.length > 0 && security.every(option => /^no-new-privileges(:true)?$/.test(option)), "security options differ from no-new-privileges");
  expect(host.ReadonlyRootfs === true, "root filesystem is writable");
  expect(["no", ""].includes(host.RestartPolicy?.Name ?? ""), "restart policy is set");
  expect(host.LogConfig?.Type === "none", "container logging is enabled");
  expect(!host.PidMode && ["", "private"].includes(host.IpcMode ?? "") && !host.UTSMode && !host.UsernsMode && !host.CgroupnsMode?.startsWith?.("host"), "host namespaces are shared");
  expect(!(host.Devices ?? []).length && !(host.DeviceRequests ?? []).length && !(host.GroupAdd ?? []).length && !(host.VolumesFrom ?? []).length, "devices, groups, or volumes-from are added");
  expect(host.Memory === memberMemory && host.PidsLimit === memberPids, "resource limits are missing");
  expect(config.User === `${process.getuid!()}:${process.getgid!()}`, `user ${config.User}`);
  expect(!Object.keys(config.Volumes ?? {}).length, "the image declares volumes");
  const allowed = new Map(sandboxMounts(plan).map(mount => [mount.target, mount]));
  const mounts: any[] = inspect?.Mounts ?? [];
  expect(mounts.length === allowed.size, `expected ${allowed.size} mounts, found ${mounts.length}`);
  for (const mount of mounts) {
    const wanted = allowed.get(mount.Destination);
    expect(mount.Type === "bind" && !!wanted && mount.Source === wanted.source && mount.RW === !wanted.readonly, `unexpected mount ${mount.Type} ${mount.Source} -> ${mount.Destination}`);
    expect(!/docker\.sock$/.test(mount.Source ?? ""), "the Docker socket is mounted");
  }
  expect(JSON.stringify(Object.keys(host.Tmpfs ?? {}).sort()) === JSON.stringify(["/tmp", plan.home, plan.agentDir].sort()), "unexpected tmpfs mounts");
  if (started) expect(inspect?.NetworkSettings && !Object.keys(inspect.NetworkSettings.Ports ?? {}).length, "ports are bound after start");
  return problems;
}
