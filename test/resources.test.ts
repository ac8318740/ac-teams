import test from "node:test";
import assert from "node:assert/strict";
import { hostResources } from "../src/resources.ts";

const memory = "MemTotal: 10000000 kB\nMemAvailable: 2000000 kB\nSwapTotal: 8000000 kB\nSwapFree: 3000000 kB\n";
const pressure = "some avg10=0.00 avg60=1.20 avg300=2.00 total=1234\nfull avg10=0.00 avg60=0.50 avg300=1.00 total=1000\n";
function reader(mem = memory, psi = pressure) {
  const paths: string[] = [];
  return { paths, read(path: string) { paths.push(path); return path === "/proc/meminfo" ? mem : psi; } };
}
test("resource check reads only two fixed files and uses available, not free, memory", () => {
  const f = reader();
  const result = hostResources(f.read, "linux");
  assert.deepEqual(f.paths, ["/proc/meminfo", "/proc/pressure/memory"]);
  assert.equal(result.scope, "host");
  assert.deepEqual(result.memory, { totalBytes: 10240000000, availableBytes: 2048000000, swapUsedBytes: 5120000000 });
  assert.deepEqual(result.memoryPressure, { someAvg10: 0, fullAvg10: 0 });
  assert.deepEqual(result.warnings, [], "occupied swap and older pressure alone do not indicate current stalls");
});
test("low headroom and recent stalls advise sequencing without a capacity promise", () => {
  const f = reader(memory.replace("2000000", "999999"), pressure.replace("some avg10=0.00", "some avg10=2.50"));
  const result = hostResources(f.read, "linux");
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], /below 10%/);
  assert.match(result.warnings[1], /2.5%/);
  const boundary = reader(memory.replace("2000000", "1000000"));
  assert.deepEqual(hostResources(boundary.read, "linux").warnings, []);
});
test("unavailable, incomplete, and invalid metrics are explicit, not zero headroom", () => {
  const unavailable = hostResources(() => { throw new Error("denied"); }, "linux");
  assert.equal(unavailable.memory, null);
  assert.equal(unavailable.memoryPressure, null);
  assert.match(unavailable.warnings.join(" "), /unavailable/);
  for (const invalid of ["", memory.replace("MemAvailable", "MemFree"), memory.replace("2000000", "-1"), memory.replace("2000000", "20000000"), memory.replace("SwapFree: 3000000", "SwapFree: 9000000"), memory.replace("10000000", "0")]) {
    const f = reader(invalid, "some avg10=NaN\nfull avg10=101.00\n");
    assert.equal(hostResources(f.read, "linux").memory, null);
    assert.equal(hostResources(f.read, "linux").memoryPressure, null);
  }
});
test("missing PSI does not discard usable memory, and unsupported platforms do not read proc", () => {
  const result = hostResources(path => { if (path.endsWith("meminfo")) return memory; throw new Error("missing"); }, "linux");
  assert.ok(result.memory);
  assert.equal(result.memoryPressure, null);
  assert.match(result.warnings.join(" "), /pressure.*unavailable/i);
  const other = hostResources(() => { assert.fail("must not read Linux paths"); }, "darwin");
  assert.equal(other.memory, null);
  assert.equal(other.memoryPressure, null);
});
