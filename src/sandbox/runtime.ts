import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, lstatSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertStableGrants, mountSet, containerProblems, dockerCreateArgs, sandboxMounts, maxSandboxed, memberImage, packageRoot, type Access, type SandboxPlan, type SandboxStatus, sandboxStatus } from "./policy.ts";
import { Egress, egressPort, providerRoutes, type Credentials } from "./egress.ts";
import { stateRoot } from "../settings/config.ts";

interface SandboxOptions {
  extension: string;
  command?: string;
  piVersion?: string;
  interactive?: boolean;
  credentials?: Credentials;
  refreshMs?: number;
  beforeStart?: (member: string) => Promise<void>;
  warning: (message: string) => void;
}

/** Owns admission, startup gates, credentials, and cleanup for enforced members. */
export class SandboxRuntime {
  private sandboxes = new Map<string, { egress: Egress; grants: { path: string; fd: number; dev: number; ino: number }[]; release: (go: boolean) => void; refresh: NodeJS.Timeout; token: string }>();
  private plans = new Map<string, SandboxPlan>();
  private releasing = new Map<string, Promise<void>>();
  private cachedStatus?: { status: SandboxStatus; at: number };

  private team: { id: string; dir: string; socketPath: string };
  private options: SandboxOptions;

  constructor(team: { id: string; dir: string; socketPath: string }, options: SandboxOptions) {
    this.team = team;
    this.options = options;
  }

  status(): SandboxStatus {
    if (!this.options.credentials) return { available: false, backend: "docker", reason: "This Pi root cannot broker provider credentials" };
    if (!this.cachedStatus || (!this.cachedStatus.status.available && Date.now() - this.cachedStatus.at > 30000)) {
      let status: SandboxStatus;
      try { status = sandboxStatus(this.image()); }
      catch (error) { status = { available: false, backend: "docker", reason: String(error) }; }
      this.cachedStatus = { status, at: Date.now() };
    }
    return this.cachedStatus.status;
  }

  async recover(id: string): Promise<void> {
    const name = this.containerName(id);
    const owner = await docker(["inspect", "--format", '{{index .Config.Labels "ac-teams.store"}}', name]).catch(() => "");
    if (owner.trim() === this.team.dir) await docker(["rm", "-f", name]).catch(error => this.options.warning(`Cannot remove orphaned member container ${name}: ${String(error)}`));
    rmSync(memberConfigDir(id), { recursive: true, force: true });
  }

  release(id: string): Promise<void> {
    const previous = this.releasing.get(id);
    if (previous) return previous;
    const release = this.releaseOnce(id);
    this.releasing.set(id, release);
    void release.finally(() => { if (this.releasing.get(id) === release) this.releasing.delete(id); }).catch(() => {});
    return release;
  }

  async close(): Promise<void> {
    for (const id of [...this.sandboxes.keys()]) await this.release(id);
    await Promise.all([...this.releasing.values()]);
  }
  image() {
    return memberImage(this.options.piVersion ?? JSON.parse(readFileSync(join(packageRoot(command("pi")), "package.json"), "utf8")).version);
  }
  containerName(id: string): string { return `ac-teams-${this.team.id}-${id}`; }
  /** Prepares a member container whose only outside channels are the coordinator socket and this member's egress proxy. */
  async prepare(id: string, access: Access, cwd: string, provider: string, model: string, args: string[], identity: Record<string, string>, sessionDir: string) {
    const credentials = this.options.credentials, route = providerRoutes[provider];
    if (!credentials || !route) throw new Error(`Enforced access supports only ${Object.keys(providerRoutes).join("/")} models with Main's Pi login`);
    const first = await credentials(provider, model); // Fails closed for unsupported providers before anything starts.
    // A resume reuses the member ID, so the previous run's cleanup must finish before its files are recreated.
    await this.releasing.get(id);
    const home = homedir(), agentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent"));
    const dir = memberConfigDir(id);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const read = (name: string) => { try { return JSON.parse(readFileSync(join(agentDir, name), "utf8")) as Record<string, unknown>; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; } };
    const write = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    // WebSocket clients may ignore proxy settings, so pin the SSE transport.
    write("settings.json", { ...read("settings.json"), transport: "sse" });
    // Only the selected provider's current access token: no refresh token and no other providers. The parent refreshes it.
    const auth = (credential: { token: string; expires: number }) => ({ [provider]: { type: "oauth", access: credential.token, refresh: "", expires: credential.expires } });
    write("auth.json", auth(first));
    // Only trust decisions for the member's cwd and its ancestors; the full file lists every trusted project.
    write("trust.json", Object.fromEntries(Object.entries(read("trust.json")).filter(([path]) => cwd === path || cwd.startsWith(path.endsWith("/") ? path : path + "/"))));
    // pi-web-access ignores proxy environment variables but honours its own proxy setting. The container has no DNS,
    // so it must leave address checks to the proxy, which refuses private and host addresses itself.
    const proxy = `http://127.0.0.1:${egressPort}`, search = read("web-search.json");
    write("web-search.json", { ...search, proxy, ssrf: { ...(search.ssrf as object | undefined), trustEnvProxy: true } });
    // The image's Pi runs members; a test command is mounted from its own package instead.
    const custom = this.options.command ?? process.env.AC_TEAMS_PI;
    const pi = custom ? command(custom) : "pi";
    const env: Record<string, string> = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home, TMPDIR: "/tmp", PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", ...identity,
      HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1", NODE_USE_ENV_PROXY: "1",
      // billion-context's spawned proxy reads its own upstream setting rather than the inherited environment.
      BILI_UPSTREAM_PROXY: proxy };
    for (const key of ["USER", "LANG", "LC_ALL", "TERM", "COLORTERM"]) if (process.env[key]) env[key] = process.env[key]!;
    const launch = join(dir, "launch.json");
    // The bridge waits on this before running any member code; it opens only after the mounts are verified.
    let release!: (go: boolean) => void;
    const gate = new Promise<boolean>(resolve => { release = resolve; });
    const egress = await Egress.open(join(this.team.dir, `e-${id}.sock`), access.network, { host: new URL(route.baseUrl).hostname, port: 443 }, gate);
    // Rewrites in place (same inode), because the file is bind-mounted; the member never sees the refresh token.
    const refresh = setInterval(() => void credentials(provider, model).then(next => {
      const current = this.sandboxes.get(id);
      if (current && next.token !== current.token) { writeFileSync(join(dir, "auth.json"), JSON.stringify(auth(next), null, 2) + "\n"); current.token = next.token; }
    }, () => this.options.warning(`Member ${id}: provider credential refresh failed`)), this.options.refreshMs ?? 60000);
    refresh.unref();
    const entry = { egress, grants: [] as { path: string; fd: number; dev: number; ino: number }[], release, refresh, token: first.token };
    this.sandboxes.set(id, entry);
    // Registered first so releaseSandbox closes the proxy if this fails. The coordinator token travels in this private file, never in container configuration that docker inspect shows.
    write("launch.json", { socket: egress.socket, port: egressPort, command: pi, args, env });
    // Hold each grant open so the started container's mounts can be compared with exactly these directories.
    for (const path of [...access.read, ...access.write]) {
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      entry.grants.push({ path, fd, ...(({ dev, ino }) => ({ dev, ino }))(fstatSync(fd)) });
      if (readlinkSync(`/proc/self/fd/${fd}`) !== path) throw new Error(`Grant ${path} changed while opening`);
    }
    const plan: SandboxPlan = {
      name: this.containerName(id), labels: { "ac-teams.team": this.team.id, "ac-teams.member": id, "ac-teams.store": this.team.dir },
      image: this.image().tag, access, cwd, home, terminal: this.options.interactive === true, agentDir, configDir: dir, sessionDir,
      coordinatorSocket: this.team.socketPath, egressSocket: egress.socket, launch,
      runtime: [...new Set([packageRoot(this.options.extension), packageRoot(fileURLToPath(import.meta.url)), ...(custom ? [packageRoot(pi)] : [])])],
      bridge: fileURLToPath(new URL("./bridge.mjs", import.meta.url)),
    };
    this.plans.set(id, plan);
    await docker(["rm", "-f", plan.name]).catch(() => {});
    const created = (await docker(dockerCreateArgs(plan))).trim();
    // Register first, then check. Grants are identity-checked at start, but runtime, transcript, and socket mounts are
    // not, so none may sit strictly inside another live member's writable grant, and no writable grant may strictly
    // contain another member's such mounts, across all teams.
    const others = (await docker(["ps", "-aq", "--no-trunc", "--filter", "label=ac-teams.member", ...["created", "running", "paused", "restarting"].flatMap(state => ["--filter", `status=${state}`])])).trim().split("\n").filter(other => other && other !== created);
    const sets = others.length ? (JSON.parse(await docker(["inspect", ...others])) as { Mounts?: { Type: string; Source: string; RW: boolean }[]; Config: { Labels?: Record<string, string> } }[])
      .map(container => mountSet((container.Mounts ?? []).filter(mount => mount.Type === "bind").map(mount => ({ source: mount.Source, rw: mount.RW })), JSON.parse(container.Config.Labels?.["ac-teams.grants"] ?? "[]"))) : [];
    assertStableGrants(mountSet(sandboxMounts(plan).map(mount => ({ source: mount.source, rw: !mount.readonly })), [...access.read, ...access.write]), sets);
    // Admission across every coordinator on this host: count after creating, so concurrent launches cannot both slip under the cap.
    const admitted = (await docker(["ps", "-aq", "--filter", "label=ac-teams.member", "--filter", "status=created", "--filter", "status=running"])).trim().split("\n").filter(Boolean).length;
    if (admitted > maxSandboxed()) throw new Error(`At most ${maxSandboxed()} enforced members can run at once on this host`);
    await this.verifyContainer(id, false);
    await this.options.beforeStart?.(id);
    return { cwd, command: "docker", args: ["start", "--attach", "--interactive", plan.name], env: { ...process.env } };
  }
  /** Refuses to run a container whose effective configuration differs from the policy. */
  private async verifyContainer(id: string, started: boolean): Promise<void> {
    const plan = this.plans.get(id)!;
    const [inspect] = JSON.parse(await docker(["inspect", plan.name]));
    const problems = containerProblems(inspect, plan, started);
    if (problems.length) throw new Error(`Member container failed policy checks: ${problems.join("; ")}`);
  }
  /**
   * After start, before any member code runs: each grant mounted in the container must be the directory held open
   * before creation. Docker resolves bind sources at start, so this is what pins grants against symlink swaps.
   */
  async start(id: string): Promise<void> {
    const sandbox = this.sandboxes.get(id)!, plan = this.plans.get(id)!;
    try {
      let pid = 0;
      for (const end = Date.now() + 30000; !pid; await new Promise(done => setTimeout(done, 100))) {
        if (Date.now() > end) throw new Error("Member container did not start");
        const [inspect] = JSON.parse(await docker(["inspect", plan.name]));
        if (inspect?.State?.Running) pid = inspect.State.Pid;
        else if (inspect?.State?.Status === "exited") throw new Error("Member container exited before release");
      }
      await this.verifyContainer(id, true);
      for (const grant of sandbox.grants) {
        const mounted = lstatSync(`/proc/${pid}/root${grant.path}`);
        if (mounted.dev !== grant.dev || mounted.ino !== grant.ino) throw new Error(`Grant ${grant.path} is not the directory that was checked`);
      }
      sandbox.release(true);
    } catch (error) { sandbox.release(false); throw error; }
    finally { for (const grant of sandbox.grants) closeSync(grant.fd); sandbox.grants = []; }
  }
  private async releaseOnce(id: string): Promise<void> {
    const sandbox = this.sandboxes.get(id), plan = this.plans.get(id);
    this.sandboxes.delete(id); this.plans.delete(id);
    if (sandbox) {
      sandbox.release(false); clearInterval(sandbox.refresh);
      // releaseMember may still hold this entry; emptying the list keeps it from closing reused descriptors.
      for (const grant of sandbox.grants) closeSync(grant.fd);
      sandbox.grants = [];
    }
    if (plan) await docker(["rm", "-f", plan.name]).catch(error => this.options.warning(`Cannot remove member container ${plan.name}: ${String(error)}`));
    await sandbox?.egress.close();
    // The member's files hold its coordinator token and provider access token.
    rmSync(memberConfigDir(id), { recursive: true, force: true });
  }
}

export const memberConfigDir = (id: string) => join(stateRoot(), "agents", id);

function command(name: string): string {
  if (name.includes("/")) return realpathSync(name);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return realpathSync(join(dir, name));
  }
  throw new Error(`Cannot find ${name} on PATH`);
}

const execFileAsync = promisify(execFile);
async function docker(args: string[]): Promise<string> {
  return (await execFileAsync("docker", args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout;
}
