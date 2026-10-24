import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
const input = createInterface({ input: process.stdin });
if (process.env.AC_TEAMS_TEST_HANG) {
  process.on("SIGTERM", () => {});
  input.on("close", () => {});
  setInterval(() => {}, 1000);
} else input.on("close", () => process.exit(0));
input.on("line", line => {
  const command = JSON.parse(line);
  const descendant = command.type === "descendant"
    ? spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{}); process.send("ready",()=>process.disconnect()); setInterval(()=>{},1000)'], { stdio: ["ignore", process.stdout, process.stderr, "ipc"] })
    : undefined;
  const respond = () => emit({ type: "response", id: command.id, success: command.type !== "fail", data: descendant?.pid ?? command.type, error: "expected failure" });
  if (descendant) descendant.once("message", respond);
  else respond();
  if (command.type === "prompt") {
    emit({ type: "agent_start" });
    emit({ type: "agent_end" });
  }
  if (command.type === "settle") emit({ type: "agent_settled" });
  if (command.type === "dialogs") emit({ type: "extension_ui_request", id: "dialog", method: "confirm" });
  if (command.type === "extension_ui_response") emit({ type: "dialog_result", cancelled: command.cancelled, confirmed: command.confirmed });
});
