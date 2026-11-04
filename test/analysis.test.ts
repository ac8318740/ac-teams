import test from "node:test";
import assert from "node:assert/strict";
import { analysisPolicy } from "../src/analysis.ts";

test("restricted access always disables warm attach, including explicit reuse and inherited settings", () => {
  const access = { read: ["/tmp"], write: [], network: {} };
  for (const analysis of [undefined, "auto", "separate"] as const) {
    for (const inherited of ["", "0", "1", "custom"]) {
      assert.deepEqual(analysisPolicy({ analysis, access }, inherited), { warmAttach: "0", reason: "separate: restricted access" });
    }
  }
});
