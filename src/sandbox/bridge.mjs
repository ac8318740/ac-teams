// Trusted bootstrap inside a member container. It exposes the parent's egress proxy on loopback, then waits for the
// parent to verify the container's mounts before running any member code (Pi, extensions, project files).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { connect, createServer } from "node:net";
import { constants } from "node:os";

const launch = JSON.parse(readFileSync(process.argv[2], "utf8"));
const fail = message => { console.error(`ac-teams sandbox bridge: ${message}`); process.exit(1); };
const server = createServer(client => {
  const upstream = connect(launch.socket);
  client.pipe(upstream).pipe(client);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
});
server.on("error", error => fail(error.message));
server.listen(launch.port, "127.0.0.1", () => {
  const gate = request({ socketPath: launch.socket, path: "http://ac-teams.invalid/start", method: "GET" }, response => {
    let body = "";
    response.on("data", chunk => { body += chunk; });
    response.on("end", () => {
      if (response.statusCode !== 200 || body !== "go") fail("the parent did not release this member");
      const child = spawn(launch.command, launch.args, { env: launch.env, stdio: "inherit" });
      for (const signal of ["SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
      process.on("SIGINT", () => {}); // The terminal already delivers Ctrl+C to Pi's process group.
      child.on("error", error => fail(error.message));
      child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1)));
    });
  });
  gate.on("error", error => fail(error.message));
  gate.end();
});
