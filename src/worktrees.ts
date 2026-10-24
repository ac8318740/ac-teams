import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Worktree } from "./types.ts";

const execute = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function identifier(value: string): void {
  check(typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value), "Invalid worktree team or member ID");
}
async function root(cwd: string): Promise<string> {
  return realpath((await git(cwd, "rev-parse", "--show-toplevel")).trim());
}
async function commit(repo: string, ref: string): Promise<string> {
  check(typeof ref === "string" && ref.length > 0 && !ref.includes("\0"), "Invalid commit reference");
  return (await git(repo, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`)).trim();
}
function location(repo: string, team: string, member: string): string {
  return join(dirname(repo), ".ac-teams-worktrees", `${basename(repo)}-${team}-${member}`);
}
async function safeParent(path: string): Promise<void> {
  const parent = dirname(path);
  const stat = await lstat(parent);
  check(await realpath(parent) === parent && stat.isDirectory(), "Worktree parent must not be a symlink");
  check(stat.uid === process.getuid?.() && !(stat.mode & 0o022), "Worktree parent must be owned by this user and not writable by others");
}

export async function createWorktree(cwd: string, team: string, member: string, base = "HEAD", target?: string): Promise<Worktree> {
  identifier(team); identifier(member);
  const repo = await root(cwd);
  const baseCommit = await commit(repo, base);
  if (target !== undefined) await commit(repo, target);
  const branch = `ac-teams/${team}/${member}`;
  await git(repo, "check-ref-format", "--branch", branch);
  const branches = await git(repo, "for-each-ref", "--format=%(refname)", `refs/heads/${branch}`);
  check(!branches.trim(), "Worktree branch already exists");
  const path = location(repo, team, member);
  const parent = dirname(path);
  try { await mkdir(parent, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  await safeParent(path);
  try { await lstat(path); throw new Error("Worktree path already exists"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await git(repo, "worktree", "add", "-b", branch, "--", path, baseCommit);
  return { repo, path, branch, base: baseCommit, ...(target === undefined ? {} : { target }) };
}

export async function removeWorktree(worktree: Worktree): Promise<void> {
  check(worktree && typeof worktree.repo === "string" && typeof worktree.path === "string" && typeof worktree.branch === "string", "Invalid worktree descriptor");
  const repo = await root(worktree.repo);
  check(repo === resolve(worktree.repo), "Worktree repository must be its real root");
  const match = /^ac-teams\/([^/]+)\/([^/]+)$/.exec(worktree.branch);
  check(match, "Not an ac-teams worktree branch");
  identifier(match[1]); identifier(match[2]);
  const expected = location(repo, match[1], match[2]);
  check(worktree.path === expected, "Worktree path does not belong to this team/member");
  await safeParent(expected);
  check(await realpath(expected) === expected && (await lstat(expected)).isDirectory(), "Worktree path must be a real directory");
  const fields = (await git(repo, "worktree", "list", "--porcelain", "-z")).split("\0");
  let entryPath: string | undefined, entryBranch: string | undefined;
  let registered = false;
  for (const field of fields) {
    if (field.startsWith("worktree ")) { entryPath = field.slice(9); entryBranch = undefined; }
    else if (field.startsWith("branch ")) entryBranch = field.slice(7);
    else if (field === "" && entryPath === expected && entryBranch === `refs/heads/${worktree.branch}`) registered = true;
  }
  check(registered && await root(expected) === expected, "Worktree path/branch is not registered in this repository");
  const common = async (cwd: string) => realpath((await git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")).trim());
  check(await common(repo) === await common(expected), "Worktree belongs to another repository");
  check(worktree.target, "No merge target recorded; retaining worktree");
  const head = await commit(expected, "HEAD");
  const target = await commit(repo, worktree.target);
  try { await git(repo, "merge-base", "--is-ancestor", head, target); }
  catch (error) {
    if ((error as { code?: number }).code === 1) throw new Error("Worktree HEAD is not an ancestor of the target; retaining unmerged work");
    throw error;
  }
  check(await commit(expected, "HEAD") === head && await commit(repo, worktree.target) === target, "Worktree or integration target changed; retaining worktree");
  // Ignored files also contain user data; check last so git cannot silently discard them.
  check(!(await git(expected, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored")).length, "Worktree is dirty or has untracked/ignored files; retaining it");
  await git(repo, "worktree", "remove", "--", expected);
}
