import test from "node:test";
import assert from "node:assert/strict";
import { hostResources } from "../src/members/resources.ts";

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
  assert.deepEqual(result.memoryPressure, { someAvg10: 0, fullAvg10: 0, fullAvg60: 0.5 });
  assert.deepEqual(result.warnings, [], "occupied swap and older pressure alone do not indicate current stalls");
});
test("low headroom warns without prescribing sequential work or promising capacity", () => {
  const f = reader(memory.replace("2000000", "999999"));
  const result = hostResources(f.read, "linux");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /below 10%/);
  assert.doesNotMatch(result.warnings[0], /sequence|sequential|stop/i);
  const boundary = reader(memory.replace("2000000", "1000000"));
  assert.deepEqual(hostResources(boundary.read, "linux").warnings, []);
});
test("only substantial recent or sustained full pressure warns, with inclusive thresholds", () => {
  for (const [some, full10, full60, warns] of [
    [0.1, 0.1, 0.5, false],
    [90, 0, 0.5, false],
    [10, 9.99, 4.99, false],
    [10, 10, 0, true],
    [0, 0, 5, true],
    [20, 10, 5, true],
  ] as const) {
    const psi = `some avg10=${some} avg60=20.00 avg300=0.00 total=1234\nfull avg10=${full10} avg60=${full60} avg300=0.00 total=1000\n`;
    const result = hostResources(reader(memory, psi).read, "linux");
    assert.deepEqual(result.memoryPressure, { someAvg10: some, fullAvg10: full10, fullAvg60: full60 });
    assert.equal(result.warnings.length, warns ? 1 : 0, psi);
    if (warns) assert.match(result.warnings[0], /consider reducing concurrency if progress is slowing/i);
  }
});
test("missing or invalid sustained pressure is unavailable rather than an all-clear", () => {
  for (const psi of [pressure.replace("avg60=0.50", "avg60=NaN"), pressure.replace("avg60=0.50", "avg60=101.00"), pressure.replace("avg60=0.50", "avg60=-1.00"), pressure.replace(" avg60=0.50", "")]) {
    const result = hostResources(reader(memory, psi).read, "linux");
    assert.equal(result.memoryPressure, null);
    assert.match(result.warnings.join(" "), /pressure.*unavailable/i);
  }
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
