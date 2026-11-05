// Holds a team with one enforced member until killed, for orphan and second-owner tests.
import { Coordinator } from "../../src/coordinator.ts";
import { extensionInventory } from "../../src/worker-extensions.ts";
const [id, home, cwd, fixture] = process.argv.slice(2);
const team = await Coordinator.open({ id, cwd, limit: 3, depth: 2, extension: fixture, command: fixture, extensions: () => extensionInventory(cwd, undefined, []), home, notice: () => {}, warning: () => {}, credentials: async () => ({ token: "unused", expires: Date.now() + 3600000 }) });
const member = await team.handle("root", "agent", { action: "launch", name: "held", model: "anthropic/claude-test", brief: "WAIT", access: { read: ["."] } }) as { id: string };
process.stdout.write(JSON.stringify({ member: member.id, dir: team.store.dir }) + "\n");
setInterval(() => {}, 1000);
