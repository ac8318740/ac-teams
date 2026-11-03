import { readFileSync } from "node:fs";

export interface HostResources {
  scope: "host";
  memory: { totalBytes: number; availableBytes: number; swapUsedBytes: number } | null;
  /** Percentage of wall time stalled on memory over the last ten seconds (Linux PSI). */
  memoryPressure: { someAvg10: number; fullAvg10: number } | null;
  warnings: string[];
}

/** On-demand advisory only: no process walks, subprocesses, timers, or per-member budget. */
export function hostResources(read: (path: string) => string = path => readFileSync(path, "utf8"), platform: string = process.platform): HostResources {
  const result: HostResources = { scope: "host", memory: null, memoryPressure: null, warnings: [] };
  if (platform === "linux") {
    try {
      const text = read("/proc/meminfo");
      const bytes = (key: string) => {
        const match = text.match(new RegExp(`^${key}:\\s+(\\d+) kB$`, "m"));
        return match ? Number(match[1]) * 1024 : NaN;
      };
      const totalBytes = bytes("MemTotal"), availableBytes = bytes("MemAvailable");
      const swapTotal = bytes("SwapTotal"), swapFree = bytes("SwapFree");
      if ([totalBytes, availableBytes, swapTotal, swapFree].every(Number.isSafeInteger) && totalBytes > 0 && availableBytes <= totalBytes && swapFree <= swapTotal) {
        result.memory = { totalBytes, availableBytes, swapUsedBytes: swapTotal - swapFree };
        if (availableBytes < totalBytes * 0.1) result.warnings.push("Host available memory is below 10%. Sequence work; stop unneeded idle members and resume their saved sessions later.");
      }
    } catch { /* Missing or unreadable metrics remain explicitly unavailable. */ }
    try {
      const text = read("/proc/pressure/memory");
      const avg = (kind: string) => {
        const match = text.match(new RegExp(`^${kind} avg10=(\\d+(?:\\.\\d+)?) `, "m"));
        return match ? Number(match[1]) : NaN;
      };
      const someAvg10 = avg("some"), fullAvg10 = avg("full");
      if ([someAvg10, fullAvg10].every(value => Number.isFinite(value) && value >= 0 && value <= 100) && fullAvg10 <= someAvg10) {
        result.memoryPressure = { someAvg10, fullAvg10 };
        if (someAvg10 > 0) result.warnings.push(`Host tasks stalled on memory for ${someAvg10}% of the last ten seconds. Prefer sequential work over more teammates.`);
      }
    } catch { /* PSI is optional on older kernels. */ }
  }
  if (!result.memory) result.warnings.push("Host memory headroom is unavailable; do not assume another teammate fits.");
  if (!result.memoryPressure) result.warnings.push("Host memory pressure is unavailable; recent stalls cannot be assessed.");
  return result;
}
