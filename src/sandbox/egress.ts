import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BlockList, connect, isIP, type Socket } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { chmodSync, unlinkSync } from "node:fs";
import { networkInterfaces } from "node:os";

/**
 * Outbound policy for a sandboxed member. `allow` undefined means any public destination; otherwise only matching
 * destinations. The member's model provider is always reachable so Pi can run; that endpoint still receives whatever
 * the member sends it.
 */
export interface NetworkPolicy { allow?: string[] }
export const egressPort = 3128;
// Each tunnel holds two descriptors in the parent (Main's Pi), so one member cannot exhaust them.
export const maxEgressConnections = 256;

// Entries: "host", "*.host" (subdomains only), each optionally ":port". Without a port, an entry allows 80 and 443.
const entryPattern = /^(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::(\d{1,5}))?$/;
function parseEntry(entry: string) {
  const match = entryPattern.exec(entry.toLowerCase());
  const port = match?.[3] === undefined ? undefined : Number(match[3]);
  if (!match || (port !== undefined && (port < 1 || port > 65535))) throw new Error(`Invalid network allow entry: ${entry}`);
  return { wildcard: !!match[1], host: match[2], ports: port === undefined ? [80, 443] : [port] };
}
export function validatePolicy(policy: NetworkPolicy): NetworkPolicy {
  if (policy.allow === undefined) return {};
  return { allow: [...new Set(policy.allow.map(entry => { parseEntry(entry); return entry.toLowerCase(); }))].sort() };
}
const covers = (entry: ReturnType<typeof parseEntry>, host: string, port: number) =>
  entry.ports.includes(port) && (entry.wildcard ? host.endsWith("." + entry.host) : host === entry.host);
export function allowed(policy: NetworkPolicy, host: string, port: number): boolean {
  return policy.allow === undefined || policy.allow.some(entry => covers(parseEntry(entry), host.toLowerCase(), port));
}
/** Throws unless the child's policy allows nothing the parent's does not. */
export function assertNetworkNarrower(parent: NetworkPolicy, child: NetworkPolicy): void {
  if (parent.allow === undefined) return;
  if (child.allow === undefined) throw new Error("A member with restricted network access cannot launch one with public access");
  for (const text of child.allow) {
    const entry = parseEntry(text);
    const ok = parent.allow.some(parentText => {
      const outer = parseEntry(parentText);
      if (!entry.ports.every(port => outer.ports.includes(port))) return false;
      if (outer.wildcard) return (entry.wildcard && entry.host === outer.host) || entry.host.endsWith("." + outer.host);
      return !entry.wildcard && entry.host === outer.host;
    });
    if (!ok) throw new Error(`Network access to ${text} exceeds the requesting member's access`);
  }
}

// Only global unicast is public. Everything else (host loopback, LAN, Docker bridges, tailscale CGNAT, link-local,
// documentation, multicast, translation prefixes) stays unreachable.
const blocked = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]] as const) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) blocked.addSubnet(address, prefix, "ipv6");
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family !== 6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]);
  // Global unicast is 2000::/3; this also excludes ::, ::1, IPv4-compatible, ULA fc00::/7, link-local, and multicast.
  const first = parseInt(address.startsWith("::") ? "0" : address.split(":")[0] || "0", 16);
  return first >= 0x2000 && first <= 0x3fff && !blocked.check(address, "ipv6");
}

/** The host's own addresses are refused even when public, so services listening on all interfaces stay unreachable. */
export function isHostAddress(address: string): boolean {
  const normal = (value: string) => value.toLowerCase().replace(/^::ffff:(?=\d)/, "").replace(/%.*$/, "");
  return Object.values(networkInterfaces()).flat().some(entry => entry && normal(entry.address) === normal(address));
}
const reachable = (address: string) => isPublicAddress(address) && !isHostAddress(address);

type Lookup = (host: string) => Promise<string[]>;
const systemLookup: Lookup = async host => (await dnsLookup(host, { all: true, verbatim: true })).map(entry => entry.address);

/** Splits an authority (host:port, [v6]:port) strictly; returns undefined for anything else. */
export function parseAuthority(authority: string, defaultPort?: number): { host: string; port: number } | undefined {
  const match = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9.-]+))(?::(\d{1,5}))?$/i.exec(authority);
  if (!match) return;
  const host = (match[1] ?? match[2]).toLowerCase(), port = match[3] === undefined ? defaultPort : Number(match[3]);
  if (port === undefined || port < 1 || port > 65535 || (match[1] && isIP(match[1]) !== 6) || (!match[1] && isIP(host) === 6)) return;
  return { host, port };
}

/** One member's outbound proxy on a private Unix socket: HTTP CONNECT and plain HTTP forwarding to public addresses only. */
export class Egress {
  readonly socket: string;
  private server: Server;
  private sockets = new Set<Socket>();
  private policy: NetworkPolicy;
  private model: { host: string; port: number };
  private lookup: Lookup;
  private isPublic: (address: string) => boolean;
  private start: Promise<boolean>;
  private started = false;
  private constructor(socket: string, policy: NetworkPolicy, model: { host: string; port: number }, start: Promise<boolean>, lookup: Lookup, isPublic: (address: string) => boolean) {
    this.socket = socket; this.policy = policy; this.model = model; this.start = start; this.lookup = lookup; this.isPublic = isPublic;
    this.server = createServer({ requestTimeout: 0, headersTimeout: 30000 }, (req, res) => void this.forward(req, res).catch(() => res.destroy()));
    this.server.on("connect", (req, client: Socket, head: Buffer) => void this.tunnel(req, client, head).catch(() => client.destroy()));
    this.server.on("connection", socket => { if (this.sockets.size >= maxEgressConnections) return socket.destroy(); this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket)); });
  }
  /** `start` resolves true once the member's mounts are verified; the bridge waits on it before running any member code. */
  static async open(socket: string, policy: NetworkPolicy, model: { host: string; port: number }, start: Promise<boolean>, lookup = systemLookup, isPublic = reachable): Promise<Egress> {
    if (Buffer.byteLength(socket) > 107) throw new Error(`Egress socket path is too long: ${socket}`);
    const egress = new Egress(socket, policy, model, start, lookup, isPublic);
    try { unlinkSync(socket); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await new Promise<void>((done, fail) => {
      egress.server.once("error", fail);
      egress.server.listen(socket, () => { try { chmodSync(socket, 0o600); done(); } catch (error) { egress.server.close(); fail(error); } });
    });
    return egress;
  }
  close(): Promise<void> {
    return new Promise(done => {
      for (const socket of this.sockets) socket.destroy();
      this.server.close(() => { try { unlinkSync(this.socket); } catch { /* Already removed. */ } done(); });
    });
  }
  private permitted(host: string, port: number): boolean {
    return (host === this.model.host && port === this.model.port) || allowed(this.policy, host, port);
  }
  /** Resolves and validates every address, then returns one to connect to, so DNS cannot change between check and connect. */
  private async resolve(host: string): Promise<string> {
    const addresses = isIP(host) ? [host] : await this.lookup(host);
    if (!addresses.length || !addresses.every(address => this.isPublic(address))) throw new Error("Destination is not a public address");
    return addresses[0];
  }
  private async tunnel(req: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    const target = parseAuthority(req.url ?? "");
    const refuse = (status: string) => { client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); };
    if (!target) return refuse("400 Bad Request");
    if (!this.permitted(target.host, target.port)) return refuse("403 Forbidden");
    let address: string;
    try { address = await this.resolve(target.host); } catch { return refuse("403 Forbidden"); }
    const upstream = connect({ host: address, port: target.port, timeout: 10000 });
    let established = false;
    upstream.once("timeout", () => upstream.destroy());
    upstream.once("connect", () => {
      established = true;
      upstream.setTimeout(300000);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      // Bytes the client sent right after CONNECT (e.g. a TLS ClientHello) arrive in `head`.
      if (head.length) upstream.write(head);
      upstream.pipe(client).pipe(upstream);
    });
    // Once tunnelled, the stream belongs to the client's protocol; an HTTP error response would corrupt it.
    upstream.on("error", () => { if (established) client.destroy(); else if (!client.destroyed) refuse("502 Bad Gateway"); });
    client.on("error", () => upstream.destroy());
    client.once("close", () => upstream.destroy());
  }
  private async forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fail = (status: number) => { if (!res.headersSent) { res.writeHead(status, { "content-type": "text/plain", connection: "close" }); res.end(); } else res.destroy(); };
    // Start gate for the in-container bridge: answered once, after mount verification.
    if (req.url === "http://ac-teams.invalid/start") {
      if (this.started) return fail(409);
      this.started = true;
      return (await this.start.catch(() => false)) ? (res.writeHead(200), void res.end("go")) : fail(403);
    }
    let url: URL;
    try { url = new URL(req.url ?? ""); } catch { return fail(400); }
    const target = url.protocol === "http:" && !url.username && !url.password ? parseAuthority(url.host, 80) : undefined;
    if (!target) return fail(400);
    if (!this.permitted(target.host, target.port)) return fail(403);
    let address: string;
    try { address = await this.resolve(target.host); } catch { return fail(403); }
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined && !/^(proxy-|connection$|keep-alive$|te$|trailer$|upgrade$|host$)/i.test(name)) headers[name] = value;
    headers.host = url.host;
    const upstream = httpRequest({ host: address, port: target.port, method: req.method, path: url.pathname + url.search, headers, timeout: 300000 }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => fail(502));
    res.once("close", () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  }
}

/** Providers whose current-token auth ac-teams can hand to a member; the endpoint stays reachable under any policy. */
export const providerRoutes: Record<string, { api: string; baseUrl: string }> = {
  anthropic: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
  openai: { api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
};
/** Resolves the provider's current access token in the trusted parent, which owns OAuth refresh. */
export type Credentials = (provider: string, model: string) => Promise<{ token: string; expires: number }>;
