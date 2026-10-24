import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, removeWorktree } from "../src/worktrees.ts";

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "ac-git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
  writeFileSync(join(repo, "file"), "initial"); git("add", "."); git("commit", "-m", "initial");
  return { dir, repo, git };
}

test("worktrees use sibling isolation and retain branches after safe removal", async t => {
  const { repo, git } = fixture(t);
  const tree = await createWorktree(repo, "team", "member", undefined, "main");
  assert.ok(!tree.path.startsWith(`${repo}/`));
  assert.equal(tree.base, git("rev-parse", "HEAD"));
  assert.equal(git("status", "--porcelain"), "");
  await assert.rejects(createWorktree(repo, "team", "member"));
  await removeWorktree(tree);
  assert.equal(existsSync(tree.path), false);
  assert.equal(git("rev-parse", "refs/heads/ac-teams/team/member"), tree.base);
});

test("cleanup refuses missing target, dirty trees, and unmerged commits", async t => {
  const { repo } = fixture(t);
  const tree = await createWorktree(repo, "team", "member");
  await assert.rejects(removeWorktree(tree), /target/i);
  tree.target = "main";
  writeFileSync(join(tree.path, "untracked"), "keep me");
  await assert.rejects(removeWorktree(tree), /dirty|untracked/i);
  execFileSync("git", ["-C", tree.path, "add", "."]);
  execFileSync("git", ["-C", tree.path, "commit", "-m", "work"], { stdio: "ignore" });
  await assert.rejects(removeWorktree(tree), /ancestor|merged/i);
  assert.equal(existsSync(tree.path), true);
  execFileSync("git", ["-C", repo, "merge", "--ff-only", tree.branch], { stdio: "ignore" });
  await removeWorktree(tree);
});

test("worktree inputs and cleanup descriptors cannot redirect deletion", async t => {
  const { repo } = fixture(t);
  await assert.rejects(createWorktree(repo, "../escape", "member"));
  await assert.rejects(createWorktree(repo, "team", "member", "--help"));
  await assert.rejects(createWorktree(repo, "team", "member", undefined, "missing"));
  const tree = await createWorktree(repo, "team", "member", undefined, "main");
  await assert.rejects(removeWorktree({ ...tree, path: repo }));
  await assert.rejects(removeWorktree({ ...tree, branch: "main" }));
  assert.equal(existsSync(tree.path), true);
  await removeWorktree(tree);
});

test("cleanup also preserves ignored and tracked local changes", async t => {
  const { repo } = fixture(t);
  const tree = await createWorktree(repo, "team", "member", undefined, "main");
  writeFileSync(join(tree.path, "file"), "changed");
  await assert.rejects(removeWorktree(tree), /dirty/i);
  writeFileSync(join(tree.path, "file"), "initial");
  writeFileSync(join(repo, ".git", "info", "exclude"), "ignored\n");
  writeFileSync(join(tree.path, "ignored"), "keep even ignored data");
  await assert.rejects(removeWorktree(tree), /ignored|dirty/i);
  assert.equal(existsSync(join(tree.path, "ignored")), true);
  rmSync(join(tree.path, "ignored"));
  await removeWorktree(tree);
});
