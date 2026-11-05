#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { record } from './record.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const repository = dirname(root);
export function discoverProblems(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^[a-z][a-z0-9-]*$/.test(entry.name))
    .filter(entry => ['PROMPT.md', 'fixture/src', 'fixture/test', 'reference/src', 'grader'].every(path => existsSync(join(directory, entry.name, path))))
    .map(entry => entry.name).sort();
}
export const problems = discoverProblems(join(root, 'problems'));

function problemPath(name) {
  if (!problems.includes(name)) throw new Error(`Unknown problem: ${name}`);
  return join(root, 'problems', name);
}

function inside(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function git(workspace, args) {
  const result = spawnSync('git', ['-C', workspace, ...args], {
    encoding: 'utf8', timeout: 10_000,
    // Never inherit GIT_DIR/GIT_WORK_TREE, hooks, signing, filters, or credentials.
    env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr);
}

export function prepare(name, destination) {
  const problem = problemPath(name);
  const workspace = resolve(destination);
  if (existsSync(workspace)) throw new Error('Destination must not exist');
  if (inside(repository, workspace)) throw new Error('Prepare outside the AC Teams repository');
  mkdirSync(dirname(workspace), { recursive: true });
  if (inside(realpathSync(repository), join(realpathSync(dirname(workspace)), workspace.split(sep).at(-1)))) {
    throw new Error('Destination resolves inside the AC Teams repository');
  }
  cpSync(join(problem, 'fixture'), workspace, { recursive: true });
  writeFileSync(join(workspace, 'TASK.md'), readFileSync(join(problem, 'PROMPT.md')));
  git(workspace, ['init', '--quiet', '--template=']);
  git(workspace, ['add', '.']);
  git(workspace, ['-c', 'user.name=AC Teams Eval', '-c', 'user.email=eval@localhost', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Initial problem fixture']);
  return workspace;
}

function testFiles(directory) {
  return readdirSync(directory).filter(name => name.endsWith('.test.ts')).sort().map(name => join(directory, name));
}

function tests(workspace, files) {
  if (!files.length) throw new Error('No test files found');
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-reporter=tap', ...files], {
    cwd: workspace,
    env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8', NODE_NO_WARNINGS: '1', EVAL_WORKSPACE: workspace },
    encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const count = key => Number(output.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] ?? 0);
  const passed = count('pass');
  const failed = count('fail');
  const ok = !result.error && result.status === 0 && count('tests') > 0 && passed > 0 && failed === 0;
  return { ok, exitCode: result.status, signal: result.signal, tests: count('tests'), passed, failed, error: result.error?.message ?? null, output };
}

export function grade(name, directory) {
  const problem = problemPath(name);
  const workspace = realpathSync(resolve(directory));
  // Preserve ../src imports while running original tests, not submission-edited tests.
  const originalTests = mkdtempSync(join(workspace, '.eval-visible-'));
  try {
    cpSync(join(problem, 'fixture', 'test'), originalTests, { recursive: true });
    const visible = tests(workspace, testFiles(originalTests));
    const additional = tests(workspace, testFiles(join(problem, 'grader')));
    return { problem: name, workspace, reward: visible.ok && additional.ok ? 1 : 0, visible, additional };
  } finally {
    rmSync(originalTests, { recursive: true, force: true });
  }
}

export function check(name) {
  problemPath(name);
  const temporary = mkdtempSync(join(tmpdir(), 'ac-teams-eval-check-'));
  try {
    const starter = prepare(name, join(temporary, 'starter'));
    const starterGrade = grade(name, starter);
    const reference = prepare(name, join(temporary, 'reference'));
    cpSync(join(problemPath(name), 'reference', 'src'), join(reference, 'src'), { recursive: true });
    const referenceGrade = grade(name, reference);
    const ok = starterGrade.visible.ok && starterGrade.reward === 0 && referenceGrade.reward === 1;
    return { problem: name, ok, starter: starterGrade, reference: referenceGrade };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function main() {
  const [command, name, directory, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Too many arguments');
  if (command === 'list' && !name) console.log(JSON.stringify(problems));
  else if (command === 'record' && name && !directory) {
    const result = record(name, grade);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.correctness.reward === 1 ? 0 : 1;
  } else if (command === 'prepare' && name && directory) console.log(JSON.stringify({ workspace: prepare(name, directory) }, null, 2));
  else if (command === 'grade' && name && directory) {
    const result = grade(name, directory);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.reward === 1 ? 0 : 1;
  } else if (command === 'check' && !directory) {
    const results = (name ? [name] : problems).map(check);
    console.log(JSON.stringify(results, null, 2));
    process.exitCode = results.every(result => result.ok) ? 0 : 1;
  } else throw new Error('Usage: node eval/run.mjs list | prepare|grade <problem> <directory> | check [problem] | record <attempt-directory>');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
