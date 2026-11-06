import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { connect, createServer as createTcpServer, type Socket } from "node:net";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Egress, allowed, maxEgressConnections, assertNetworkNarrower, isHostAddress, isPublicAddress, parseAuthority, validatePolicy } from "../src/egress.ts";
import { networkInterfaces } from "node:os";

const until = async (check: () => boolean) => { for (const end = Date.now() + 5000; !check(); await new Promise(resolve => setTimeout(resolve, 20))) if (Date.now() > end) throw new Error("Condition timed out"); };

test("only global unicast addresses are public, including inside mapped and translated forms", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8"]) assert.equal(isPublicAddress(address), true, address);
  for (const address of ["127.0.0.1", "10.1.2.3", "172.17.0.1", "192.168.1.1", "100.80.93.45", "169.254.169.254", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
    "::1", "::", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::127.0.0.1", "fc00::1", "fd7a:115c:a1e0::1", "fe80::1", "ff02::1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1", "not-an-ip"]) assert.equal(isPublicAddress(address), false, address);
});

test("every address of this host is refused, including public ones", () => {
  const own = Object.values(networkInterfaces()).flat().map(entry => entry!.address);
  for (const address of own) assert.equal(isHostAddress(address), true, address);
  assert.equal(isHostAddress("8.8.8.8"), own.includes("8.8.8.8"));
});

test("allowlists name hosts and ports explicitly, and children can only narrow them", () => {
  const policy = validatePolicy({ allow: ["Docs.Example.com", "*.github.com", "api.test.dev:8443"] });
  assert.equal(allowed(policy, "docs.example.com", 443), true);
  assert.equal(allowed(policy, "docs.example.com", 80), true);
  assert.equal(allowed(policy, "docs.example.com", 8080), false);
  assert.equal(allowed(policy, "raw.github.com", 443), true);
  assert.equal(allowed(policy, "github.com", 443), false, "*.host matches subdomains only");
  assert.equal(allowed(policy, "evilgithub.com", 443), false);
  assert.equal(allowed(policy, "api.test.dev", 8443), true);
  assert.equal(allowed(policy, "api.test.dev", 443), false);
  assert.equal(allowed({}, "anything.example", 22), true, "no allowlist means any public destination");
  assert.equal(allowed({ allow: [] }, "docs.example.com", 443), false);
  for (const bad of ["*", "http://x.com", "x.com/path", "x", "x.com:0", "x.com:70000", "*.*.com", "x.com:"]) assert.throws(() => validatePolicy({ allow: [bad] }), /Invalid network allow entry/, bad);
  assertNetworkNarrower({}, {});
  assertNetworkNarrower({}, { allow: ["a.example.com"] });
  assertNetworkNarrower({ allow: ["*.github.com"] }, { allow: ["raw.github.com", "*.api.github.com"] });
  assertNetworkNarrower({ allow: ["x.example.com"] }, { allow: ["x.example.com:443"] });
  assertNetworkNarrower({ allow: ["x.example.com"] }, { allow: [] });
  assert.throws(() => assertNetworkNarrower({ allow: [] }, {}), /restricted network access cannot launch one with public access/);
  assert.throws(() => assertNetworkNarrower({ allow: ["raw.github.com"] }, { allow: ["*.github.com"] }), /exceeds/);
  assert.throws(() => assertNetworkNarrower({ allow: ["*.github.com"] }, { allow: ["github.com"] }), /exceeds/);
  assert.throws(() => assertNetworkNarrower({ allow: ["x.example.com"] }, { allow: ["x.example.com:22"] }), /exceeds/);
});

test("wildcard inheritance permits equal or narrower subdomains and ports, never an apex or wider policy", () => {
  for (const [parent, child] of [
    ["*.github.com", "*.github.com"],
    ["*.github.com", "*.github.com:443"],
    ["*.github.com:8443", "*.github.com:8443"],
    ["*.github.com", "*.api.github.com"],
    ["*.github.com:8443", "*.api.github.com:8443"],
  ]) {
    assert.doesNotThrow(() => assertNetworkNarrower({ allow: [parent] }, { allow: [child] }), `${parent} permits ${child}`);
  }
  for (const [parent, child] of [
    ["*.github.com", "github.com"],
    ["*.github.com", "*.evilgithub.com"],
    ["*.api.github.com", "*.github.com"],
    ["raw.github.com", "*.github.com"],
    ["*.github.com", "*.github.com:8443"],
    ["*.github.com:443", "*.github.com"],
    ["*.github.com:8443", "*.api.github.com"],
  ]) {
    assert.throws(() => assertNetworkNarrower({ allow: [parent] }, { allow: [child] }), /exceeds/, `${parent} refuses ${child}`);
  }
});

test("authorities are parsed strictly", () => {
  assert.deepEqual(parseAuthority("example.com:443"), { host: "example.com", port: 443 });
  assert.deepEqual(parseAuthority("[2606:4700::1]:443"), { host: "2606:4700::1", port: 443 });
  assert.deepEqual(parseAuthority("example.com", 80), { host: "example.com", port: 80 });
  for (const bad of ["example.com", "example.com:0", "example.com:99999", "user@example.com:443", "example.com:443/x", "2606:4700::1:443", "[not-v6]:443", "exa mple.com:443"]) assert.equal(parseAuthority(bad), undefined, bad);
});

async function setup(policy = {}, map: Record<string, string[]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "egr-"));
  const seen: { url?: string; headers: IncomingHttpHeaders }[] = [];
  const upstream = createServer((req, res) => { seen.push({ url: req.url, headers: req.headers }); res.writeHead(302, { location: "http://127.0.0.1/" }); res.end("public"); }).listen(0, "127.0.0.2");
  await once(upstream, "listening");
  const port = (upstream.address() as { port: number }).port;
  let release!: (go: boolean) => void;
  const start = new Promise<boolean>(resolve => { release = resolve; });
  // Test resolver and classifier: "public.test" stands for a public host served locally; real classification stays for every other address.
  const egress = await Egress.open(join(dir, "e.sock"), policy, { host: "model.test", port }, start,
    async host => map[host] ?? (host === "public.test" || host === "model.test" ? ["127.0.0.2"] : ["127.0.0.1"]),
    address => address === "127.0.0.2" || (isPublicAddress(address) && !isHostAddress(address)));
  const via = (url: string) => new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>(resolve => {
    const req = request({ socketPath: egress.socket, path: url, headers: { "proxy-authorization": "x" } }, res => { let body = ""; res.on("data", c => { body += c; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers })); });
    req.on("error", () => resolve({ status: 0, body: "", headers: {} })); req.end();
  });
  const tunnel = (authority: string) => new Promise<string>(resolve => {
    const socket = connect(egress.socket);
    socket.on("data", chunk => { resolve(String(chunk).split("\r\n")[0]); socket.destroy(); });
    socket.on("error", () => resolve("error"));
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  });
  return { egress, port, seen, via, tunnel, release, async close() { await egress.close(); upstream.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("the proxy reaches public destinations only, re-checks every request, and never follows redirects", async () => {
  const f = await setup();
  try {
    assert.equal(statSync(f.egress.socket).mode & 0o777, 0o600);
    // 127.0.0.2 stands in for a public address here.
    const ok = await f.via(`http://public.test:${f.port}/doc?q=1`);
    assert.deepEqual([ok.status, ok.body, ok.headers.location], [302, "public", "http://127.0.0.1/"], "redirects are returned, not followed");
    assert.equal(f.seen[0].url, "/doc?q=1");
    assert.equal(f.seen[0].headers.host, `public.test:${f.port}`);
    assert.equal(f.seen[0].headers["proxy-authorization"], undefined);
    assert.match(await f.tunnel(`public.test:${f.port}`), /200 Connection Established/);
    for (const target of [`http://127.0.0.1:${f.port}/`, `http://localhost:${f.port}/`, "http://[::1]/", "http://169.254.169.254/latest/meta-data/", "http://100.80.93.45/", "http://172.17.0.1/", "http://10.0.0.1/"])
      assert.equal((await f.via(target)).status, 403, target);
    for (const authority of [`127.0.0.1:${f.port}`, "[::1]:443", "localhost:443", "172.17.0.1:2375", "[::ffff:127.0.0.1]:22", "100.80.93.45:22"])
      assert.match(await f.tunnel(authority), /403/, authority);
    assert.match(await f.tunnel("not an authority"), /400/);
    for (const bad of ["ftp://public.test/", "http://user:pass@public.test/", "/relative"]) assert.equal((await f.via(bad)).status, 400, bad);
  } finally { await f.close(); }
});

test("a host is refused when any of its resolved addresses is not public", async () => {
  const f = await setup({}, { "mixed.test": ["8.8.8.8", "127.0.0.1"], "v6.test": ["2606:4700::1", "fd00::1"] });
  try {
    assert.equal((await f.via("http://mixed.test/")).status, 403);
    assert.match(await f.tunnel("v6.test:443"), /403/);
  } finally { await f.close(); }
});

test("allowlists apply to CONNECT and plain requests, and the model provider stays reachable", async () => {
  const f = await setup({ allow: ["docs.test"] });
  try {
    assert.equal((await f.via("http://other.test/")).status, 403);
    assert.match(await f.tunnel("other.test:443"), /403/);
    assert.match(await f.tunnel(`model.test:${f.port}`), /200/, "the model endpoint is reachable under any allowlist");
  } finally { await f.close(); }
});

test("CONNECT keeps bytes sent with the request, closes a broken tunnel without injecting HTTP, and caps connections", async () => {
  const dir = mkdtempSync(join(tmpdir(), "egr-"));
  const received: string[] = [];
  const upstream = createTcpServer(socket => socket.once("data", chunk => { received.push(String(chunk)); socket.resetAndDestroy(); })).listen(0, "127.0.0.2");
  await once(upstream, "listening");
  const port = (upstream.address() as { port: number }).port;
  const egress = await Egress.open(join(dir, "e.sock"), {}, { host: "model.test", port }, new Promise(() => {}), async () => ["127.0.0.2"], address => address === "127.0.0.2");
  try {
    const socket = connect(egress.socket);
    let reply = "";
    socket.on("data", chunk => { reply += chunk; });
    socket.write(`CONNECT public.test:${port} HTTP/1.1\r\n\r\nHELLO`);
    await once(socket, "close");
    assert.deepEqual(received, ["HELLO"]);
    assert.equal(reply, "HTTP/1.1 200 Connection Established\r\n\r\n", "an upstream reset closes the tunnel instead of writing a 502 into it");
    const held = await Promise.all(Array.from({ length: maxEgressConnections + 1 }, () => new Promise<Socket>(resolve => { const s = connect(egress.socket, () => resolve(s)); })));
    await until(() => held.some(s => s.destroyed));
    assert.equal(held.filter(s => !s.destroyed).length, maxEgressConnections);
    for (const s of held) s.destroy();
  } finally { await egress.close(); upstream.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("the start gate answers once, only after release, and fails closed", async () => {
  const f = await setup();
  try {
    const first = f.via("http://ac-teams.invalid/start");
    f.release(true);
    assert.deepEqual([(await first).status, (await first).body], [200, "go"]);
    assert.equal((await f.via("http://ac-teams.invalid/start")).status, 409, "a second request is refused");
  } finally { await f.close(); }
  const g = await setup();
  try {
    const gate = g.via("http://ac-teams.invalid/start");
    g.release(false);
    assert.equal((await gate).status, 403);
  } finally { await g.close(); }
});
