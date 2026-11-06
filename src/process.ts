import { readFileSync } from "node:fs";

function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
function requireValue(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function integer(value: unknown, min = 0): value is number { return Number.isSafeInteger(value) && (value as number) >= min; }
export function processIdentity(pid: number): string | undefined {
  requireValue(integer(pid, 1), "Invalid PID");
  requireValue(process.platform === "linux", "Process identity is only supported on Linux");
  let stat: string;
  try { stat = readFileSync(`/proc/${pid}/stat`, "utf8"); }
  catch (error) {
    if (code(error) === "ENOENT" || code(error) === "ESRCH") {
      try { process.kill(pid, 0); }
      catch (probe) { if (code(probe) === "ESRCH") return undefined; throw probe; }
      throw new Error("Cannot determine identity of a live process");
    }
    throw error;
  }
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  if (fields[0] === "Z" || fields[0] === "X") return undefined;
  const start = fields[19];
  requireValue(start && /^\d+$/.test(start), "Cannot determine process identity");
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  requireValue(boot, "Cannot determine boot identity");
  return `${boot}:${start}`;
}

export function processAlive(pid: number, identity?: string): boolean {
  requireValue(integer(pid, 1), "Invalid PID");
  try { process.kill(pid, 0); }
  catch (error) { if (code(error) === "ESRCH") return false; throw error; }
  const actual = processIdentity(pid);
  return actual !== undefined && (identity === undefined || actual === identity);
}
