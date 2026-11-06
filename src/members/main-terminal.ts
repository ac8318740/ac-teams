import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Member } from "../types.ts";

const exec = promisify(execFile);
/** Pi custom entry in a main session's transcript: which team it belongs to. Holds no secrets. */
export const teamEntryType = "ac-teams-team";
export interface TeamEntry { team: string; member: string; left?: boolean }
export const handoverPrompt = "Your process was restarted during a coordinator handover. Check your last steps and continue your current task.";

/** A main session's environment: no member identity, member role, or member Herdr opt-out. */
export function mainEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || key === "ACSTACK_AGENT_ROLE" || key.startsWith("AC_TEAMS_") || (key === "HERDR_ENV" && value === "0") || key === "TMUX" || key === "TMUX_PANE") continue;
    clean[key] = value;
  }
  return clean;
}

export async function visitMain(member: Pick<Member, "sessionId" | "sessionFile">): Promise<void> {
  if (process.env.HERDR_ENV !== "1") throw new Error("Open this main in its own terminal. Tab switching requires Herdr.");
  try {
    const result = JSON.parse((await exec("herdr", ["agent", "list"], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })).stdout);
    const agents = result.result?.agents;
    if (!Array.isArray(agents)) throw new Error("Missing agents");
    const matches = agents.filter(agent => agent?.agent === "pi" && typeof agent.pane_id === "string" && (
      (member.sessionFile && agent.agent_session?.kind === "path" && agent.agent_session.value === member.sessionFile) ||
      (member.sessionId && agent.agent_session?.kind === "id" && agent.agent_session.value === member.sessionId)
    ));
    if (matches.length !== 1) throw new Error("Main is unavailable or ambiguous");
    await exec("herdr", ["agent", "focus", matches[0].pane_id], { timeout: 5000, maxBuffer: 65536 });
  } catch { throw new Error("Could not find or switch to this main in Herdr. Open its tab manually."); }
}

export interface MainLaunch { id: string; name: string; cwd: string; command: string[]; env: Record<string, string>; socket: string }
/**
 * Opens a main session where the user can switch to it: its own Herdr tab in the workspace for its worktree, or else a
 * tmux session on a socket of its own, so the coordinator owner's tmux kill-server cannot reach it. Returns a user notice.
 */
export async function launchMain(spec: MainLaunch): Promise<string> {
  if (spec.env.HERDR_ENV === "1") {
    const herdr = async (...args: string[]) => JSON.parse((await exec("herdr", args, { env: spec.env, timeout: 10000, maxBuffer: 4 * 1024 * 1024 })).stdout);
    const workspaces = (await herdr("workspace", "list")).result?.workspaces as { workspace_id: string; worktree?: { checkout_path?: string } }[] | undefined;
    const workspace = workspaces?.find(entry => entry.worktree?.checkout_path === spec.cwd);
    const created = workspace
      ? await herdr("tab", "create", "--workspace", workspace.workspace_id, "--cwd", spec.cwd, "--label", spec.name, "--focus")
      : await herdr("workspace", "create", "--cwd", spec.cwd, "--label", spec.name, "--focus");
    const pane = created.result?.root_pane?.pane_id;
    if (typeof pane !== "string") throw new Error("Herdr did not report the new tab's pane");
    // Herdr types the command into the pane's shell, so each word is quoted for it.
    await exec("herdr", ["pane", "run", pane, spec.command.map(word => `'${word.replaceAll("'", "'\\''")}'`).join(" ")], { env: spec.env, timeout: 10000 });
    return `${spec.name} opened in its own Herdr tab`;
  }
  await exec("tmux", ["-S", spec.socket, "new-session", "-d", "-s", spec.id, "-c", spec.cwd, "--", ...spec.command], { env: spec.env, timeout: 10000 });
  return `${spec.name} runs in tmux; attach with: tmux -S ${spec.socket} attach -t ${spec.id}`;
}
