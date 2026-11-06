import { DefaultResourceLoader, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { observeLoadedExtensions } from "./settings/loaded-extensions.ts";
import { extensionInventory } from "./settings/worker-extensions.ts";
import { teamMessageRenderer } from "./ui/render.ts";
import { createSession } from "./extension/session.ts";
import { createPresentation } from "./extension/presentation.ts";
import { createEvents } from "./extension/events.ts";
import { registerTools } from "./extension/tools.ts";
import { registerCommands } from "./extension/commands.ts";

const extension = fileURLToPath(import.meta.url);

export default function teams(pi: ExtensionAPI) {
  const observedExtensions = observeLoadedExtensions(DefaultResourceLoader);
  let loadedPaths: string[] | undefined;
  const parentInventory = async () => {
    const context = session.context;
    if (!loadedPaths || !context) throw new Error("Cannot observe this Pi runtime's loaded extensions. Preset launches are disabled; reload on a supported stock Pi version.");
    return extensionInventory(context.cwd, undefined, loadedPaths.filter(path => path !== extension));
  };
  pi.registerFlag("teams-limit", { description: "Explicit maximum live ac-teams members (default 10, idle members count)", type: "string" });
  pi.registerFlag("teams-depth", { description: "Maximum descendant depth (root is 0, default 2)", type: "string" });
  pi.registerFlag("teams-project-config", { description: "Trust .pi/ac-teams.json policy in the current project", type: "boolean", default: false });
  const session = createSession(pi, extension, () => loadedPaths, parentInventory, {
    close() { events.stopTelemetry(); presentation.dispose(); },
    joined(ctx) { events.startTelemetry(ctx); presentation.installUI(ctx); },
    switched() { presentation.clearDrafts(); },
  });
  const presentation = createPresentation(pi, session);
  pi.registerMessageRenderer("ac-teams", teamMessageRenderer(session.memberLabels, session.memberId));
  const teamAgentTool = registerTools(pi, session, parentInventory);
  const events = createEvents(pi, session, presentation, () => {
    loadedPaths ??= observedExtensions(extension => Object.is(extension.tools.get("team_agent")?.definition, teamAgentTool));
  });
  registerCommands(pi, session, presentation);
}
