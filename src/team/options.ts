import type { ExtensionInventory } from "../settings/worker-extensions.ts";
import type { HostResources } from "../members/resources.ts";
import type { MainLaunch } from "../members/main-terminal.ts";
import type { Credentials } from "../sandbox/egress.ts";
import type { Message } from "../types.ts";

export interface CoordinatorOptions {
  /** Team ID: the session ID of the session that created the team. */
  id: string; cwd: string; sessionFile?: string; limit: number; depth: number;
  /** This session's member ID in the team (default "root", the creator); sessionId defaults to the team ID. */
  self?: string; sessionId?: string;
  /** Add this session to an existing team as a new main session (/teams join with no coordinator running). */
  join?: boolean;
  /** Another main session asked this owner session to shut down. */
  shutdown?: () => void;
  /** Test hook: opens a main session's terminal (default: a Herdr tab, else tmux). */
  launchMain?: (spec: MainLaunch) => Promise<string>;
  /** Test hook: runs after each recorded promotion step. */
  promotionStep?: (step: string) => Promise<void> | void;
  extension: string; home?: string; command?: string;
  interactive?: boolean; model?: string; thinking?: string;
  /** Opt-in to project worker policy, additionally gated by native Pi trust for each cwd. */
  projectConfig?: boolean;
  /** The hosting main's actual successful native load, not a discovery-based approximation. */
  extensions?: () => Promise<ExtensionInventory>;
  /** Version of the running Pi; members use the image built for it. Defaults to the `pi` on PATH. */
  piVersion?: string;
  /** Test hook: samples host headroom without depending on the test machine's load. */
  resources?: () => HostResources;
  /** Test hook: provider token refresh interval (default one minute). */
  refreshMs?: number;
  /** Test hook: how long a member may stay idle before the coordinator stops it (default five minutes). */
  idleStopMs?: number;
  /** Test hook: runs after a member container passes all checks and before it starts. */
  beforeStart?: (member: string) => Promise<void>;
  /** Main's session directory; member transcripts live under <it>/ac-teams/<team>/<member>. */
  sessionDir?: string;
  /** Parent-side provider credentials for sandboxed members; without it enforced access is unavailable. */
  credentials?: Credentials;
  notice: (through: number, messages: Message[]) => void;
  warning: (message: string) => void;
  status?: (kind: "busy" | "blocked", active: boolean) => void;
}
