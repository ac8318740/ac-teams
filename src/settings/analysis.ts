import type { Member } from "../types.ts";

/** Launch policy only: pi-lens owns attachment, compatibility, and fallback. */
export function analysisPolicy(member: Pick<Member, "analysis" | "access">, inherited = process.env.PI_LENS_WARM_ATTACH) {
  if (member.access) return { warmAttach: "0", reason: "separate: restricted access" };
  if (member.analysis === "separate") return { warmAttach: "0", reason: "separate requested" };
  if (inherited === "0") return { warmAttach: "0", reason: "separate: explicit opt-out" };
  if (inherited && inherited !== "1") return { warmAttach: inherited, reason: "inherited setting unchanged" };
  return { warmAttach: "1", reason: "reuse requested" };
}
