import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { memberName, type Member } from "./types.ts";
import { cleanText } from "./render.ts";

type NamedMember = Pick<Member, "id" | "name" | "status">;
const actions = ["panel", "teammate", "config", "back", "stop", "status"];

export function resolveTeammate(members: NamedMember[], value: string): string | undefined {
  const key = value === "main" ? "root" : value;
  return members.find(member => member.id === key)?.id ?? members.find(member => member.name === key)?.id;
}

export function teamsCompletions(prefix: string, members: NamedMember[]): AutocompleteItem[] | null {
  if (!prefix.includes(" ")) return actions.filter(action => action.startsWith(prefix)).map(action => ({ value: action, label: action }));
  const match = /^(teammate|open)\s+(\S*)$/.exec(prefix);
  if (!match) return null;
  return members.filter(member => (member.id === "root" ? "main" : memberName(member)).startsWith(match[2]) || member.id.startsWith(match[2])).map(member => {
    const name = member.id === "root" ? "main" : memberName(member);
    return { value: `${match[1]} ${name}`, label: cleanText(name), description: `${member.status} · ${member.id}` };
  });
}
