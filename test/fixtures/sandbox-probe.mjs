// Runs inside an enforced member and records what it can reach. Every check reports, never throws.
import { readFileSync, writeFileSync, readdirSync, readlinkSync, existsSync } from "node:fs";
import { connect } from "node:net";
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";

const attempt = fn => { try { return { ok: true, value: fn() }; } catch (error) { return { ok: false, code: error.code ?? String(error.message).slice(0, 120) }; } };
const dial = options => new Promise(resolve => {
  const socket = connect(options);
  const done = result => { socket.destroy(); resolve(result); };
  socket.setTimeout(2000, () => done({ ok: false, code: "TIMEOUT" }));
  socket.on("connect", () => done({ ok: true }));
  socket.on("error", error => done({ ok: false, code: error.code }));
});
const post = (path, headers) => new Promise(resolve => {
  const req = httpRequest({ host: "127.0.0.1", port: 18080, path, method: "POST", headers }, res => {
    let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode, body: body.slice(0, 300) }));
  });
  req.on("error", error => resolve({ status: 0, body: error.code }));
  req.end("{}");
});
const run = (command, args, env = process.env) => { const r = spawnSync(command, args, { encoding: "utf8", timeout: 15000, env }); return { status: r.status, error: r.error?.code, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().slice(0, 160) }; };

export async function probe(config, request) {
  const result = {};
  result.readOutside = attempt(() => readFileSync(config.outsideFile, "utf8"));
  result.readGranted = attempt(() => readFileSync(config.readFile, "utf8"));
  result.writeReadGrant = attempt(() => writeFileSync(config.readFile, "changed"));
  result.writeWriteGrant = attempt(() => writeFileSync(config.writeFile, "changed"));
  // Write grants cover Git metadata too: changing it is authorized, not an escape.
  result.writeGitHook = attempt(() => writeFileSync(config.gitHook, "#!/bin/sh\n"));
  result.writeRoot = attempt(() => writeFileSync("/usr/ac-teams-probe", "x"));
  result.auth = attempt(() => readFileSync(`${config.agentDir}/auth.json`, "utf8"));
  result.trust = attempt(() => readFileSync(`${config.agentDir}/trust.json`, "utf8"));
  result.sessionsListing = attempt(() => readdirSync(`${config.agentDir}/sessions`));
  result.otherTranscript = attempt(() => readFileSync(config.otherTranscript, "utf8"));
  result.teamState = attempt(() => readFileSync(config.teamState, "utf8"));
  result.terminalSocket = existsSync(config.terminalSocket);
  result.dockerSocket = existsSync("/var/run/docker.sock") || existsSync("/run/docker.sock");
  result.hostTcp = await dial({ host: "127.0.0.1", port: config.hostPort });
  result.internet = await dial({ host: "1.1.1.1", port: 443 });
  result.hostUnixSocket = await dial({ path: config.hostUnixSocket });
  // Outbound goes only through the parent's proxy, which refuses private and host addresses.
  const code = (args) => run("curl", ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "20", ...args]).out;
  result.publicHttps = code(["https://example.com/"]);
  result.publicHttp = code(["http://example.com/"]);
  result.hostAddresses = Object.fromEntries(config.hostAddresses.flatMap(address => [[`http://${address}:${config.hostPort}/`, code(["--proxy", "http://127.0.0.1:3128", "--noproxy", "", `http://${address.includes(":") ? `[${address}]` : address}:${config.hostPort}/`])],
    [`connect ${address}:22`, code(["--proxy", "http://127.0.0.1:3128", "--noproxy", "", "--proxytunnel", `http://${address.includes(":") ? `[${address}]` : address}:22/`])]]));
  result.dockerBridge = code(["--proxy", "http://127.0.0.1:3128", "--noproxy", "", "http://172.17.0.1/"]);
  result.metadata = code(["--proxy", "http://127.0.0.1:3128", "--noproxy", "", "http://169.254.169.254/latest/meta-data/"]);
  result.nodeProxyFetch = run(process.execPath, ["-e", "fetch('https://example.com/').then(r=>console.log('status',r.status),e=>console.log('error',e.cause?.code??e.message))"]).out;
  // Without proxy settings a client has no network at all.
  result.cleanNodeFetch = run(process.execPath, ["-e", "fetch('https://example.com/').then(r=>console.log('status',r.status),e=>console.log('error',e.cause?.code??e.message))"], { PATH: process.env.PATH }).out;
  result.udp = run(process.execPath, ["-e", "const s=require('dgram').createSocket('udp4');s.send('x',53,'1.1.1.1',e=>{console.log(e?e.code:'sent');s.close()})"]).out;
  result.startAgain = run("curl", ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--proxy", "http://127.0.0.1:3128", "http://ac-teams.invalid/start"]).out;
  const pids = readdirSync("/proc").filter(name => /^\d+$/.test(name));
  result.pids = pids.length;
  result.coordinatorVisible = pids.includes(String(config.coordinatorPid));
  result.killCoordinator = attempt(() => process.kill(config.coordinatorPid, 0));
  const status = readFileSync("/proc/self/status", "utf8");
  result.capEff = status.match(/CapEff:\s*(\w+)/)?.[1];
  result.capBnd = status.match(/CapBnd:\s*(\w+)/)?.[1];
  result.noNewPrivs = status.match(/NoNewPrivs:\s*(\d)/)?.[1];
  result.uid = process.getuid();
  result.unshareUser = run("unshare", ["-U", "true"]);
  result.mount = run("mount", ["-t", "tmpfs", "none", "/tmp"]);
  result.tty = attempt(() => readlinkSync("/proc/self/fd/0"));
  result.tiocsti = run("perl", ["-e", "open(my $t, '+<', '/dev/tty') or die \"open: $!\\n\"; my $c = 'x'; ioctl($t, 0x5412, $c) or die \"ioctl: $!\\n\"; print 'injected'"], { PATH: process.env.PATH, LC_ALL: "C" });
  result.hostSecretEnv = process.env.AC_TEAMS_TEST_SECRET ?? null;
  result.terminalSocketEnv = process.env.AC_TEAMS_TERMINAL_SOCKET ?? null;
  result.accessEnv = process.env.AC_TEAMS_ACCESS ?? null;
  result.fds = readdirSync("/proc/self/fd").map(fd => attempt(() => readlinkSync(`/proc/self/fd/${fd}`))).map(entry => entry.value ?? entry.code)
    .filter(target => typeof target === "string" && target.startsWith("/") && !target.startsWith("/dev/") && !target.startsWith("/proc/"));
  result.authFile = attempt(() => JSON.parse(readFileSync(`${config.agentDir}/auth.json`, "utf8")));
  result.webSearch = attempt(() => JSON.parse(readFileSync(`${config.agentDir}/web-search.json`, "utf8")));
  result.escalate = await request("agent", { action: "launch", name: "escalate", brief: "x", model: config.model, access: { write: [config.readDir] } }).then(() => "launched", error => error.message);
  result.unsandboxedChild = await request("agent", { action: "launch", name: "plain", brief: "x", model: config.model, cwd: "/" }).then(() => "launched", error => error.message);
  result.userAction = await request("ui", { action: "resume", id: "root" }).then(() => "sent", error => error.message);
  result.nested = await request("agent", { action: "launch", name: "nested", brief: "x", model: config.model, access: { read: [config.readDir], network: { allow: [] } }, cwd: config.readDir }).then(member => ({ access: member.access, id: member.id }), error => error.message);
  // Re-read after the nested launch: the sibling's transcript directory exists on the host but must stay invisible.
  result.ownTranscripts = attempt(() => readdirSync(config.ownSessions));
  return result;
}
