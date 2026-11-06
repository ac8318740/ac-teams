import { readFileSync } from "node:fs";

export interface HostResources {
  scope: "host";
  memory: { totalBytes: number; availableBytes: number; swapUsedBytes: number } | null;
  /** Linux PSI percentages: partial ten-second pressure and full ten-/sixty-second pressure. */
  memoryPressure: { someAvg10: number; fullAvg10: number; fullAvg60: number } | null;
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
        if (availableBytes < totalBytes * 0.1) result.warnings.push("Host available memory is below 10%. This is low headroom, not a per-member capacity estimate.");
      }
    } catch { /* Missing or unreadable metrics remain explicitly unavailable. */ }
    try {
      const text = read("/proc/pressure/memory");
      const avg = (kind: string, window: 10 | 60) => {
        const match = text.match(new RegExp(`^${kind} .*?\\bavg${window}=(\\d+(?:\\.\\d+)?) `, "m"));
        return match ? Number(match[1]) : NaN;
      };
      const someAvg10 = avg("some", 10), fullAvg10 = avg("full", 10), fullAvg60 = avg("full", 60);
      if ([someAvg10, fullAvg10, fullAvg60].every(value => Number.isFinite(value) && value >= 0 && value <= 100) && fullAvg10 <= someAvg10) {
        result.memoryPressure = { someAvg10, fullAvg10, fullAvg60 };
        if (fullAvg60 >= 5 || fullAvg10 >= 10) result.warnings.push(`Significant memory contention detected (full avg10: ${fullAvg10}%, full avg60: ${fullAvg60}%). Consider reducing concurrency if progress is slowing.`);
      }
    } catch { /* PSI is optional on older kernels. */ }
  }
  if (!result.memory) result.warnings.push("Host memory headroom is unavailable; do not assume another teammate fits.");
  if (!result.memoryPressure) result.warnings.push("Host memory pressure is unavailable; recent stalls cannot be assessed.");
  return result;
}
