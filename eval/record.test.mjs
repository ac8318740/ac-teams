import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { collectUsage, record } from './record.mjs';
import { discoverProblems, grade } from './run.mjs';

const write = (path, value) => writeFileSync(path, `${JSON.stringify(value)}\n`);
function hashes(root) {
  const result = {};
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) walk(file);
      else result[relative(root, file)] = createHash('sha256').update(readFileSync(file)).digest('hex');
    }
  }
  walk(root); return result;
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'eval-record-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'submission'));
  writeFileSync(join(directory, 'submission', 'src.txt'), 'unchanged');
  write(join(directory, 'submission-manifest.json'), hashes(join(directory, 'submission')));
  write(join(directory, 'shutdown.json'), { confirmed_exited: true });
  write(join(directory, 'completion.json'), { task: 'event-delivery', result: { attempt_seconds: 12.345 } });
  write(join(directory, 'environment.json'), { extensions: [{ id: 'test-only', version: '0.0.0', sha256: 'a'.repeat(64) }], runtime: { node: process.version }, model: { id: 'test-only-no-model-call' } });
  mkdirSync(join(directory, 'sessions', 'child'), { recursive: true });
  for (const [path, input, output, cached] of [['root.jsonl', 10, 3, 5], ['child/child.jsonl', 20, 7, 11]]) {
    write(join(directory, 'sessions', path), { message: { role: 'assistant', content: [{ type: 'toolCall', name: 'team_message', arguments: { action: 'watch' } }], usage: { input, output, cacheRead: cached, cacheWrite: 0, reasoning: 2, totalTokens: input + output + cached } } });
  }
  return directory;
}
const fakeGrade = () => ({ reward: 1, visible: { tests: 1, passed: 1, failed: 0 }, additional: { tests: 1, passed: 1, failed: 0 } });

test('record aggregates all sessions, reasoning is not double-counted, and metadata survives', t => {
  const directory = fixture(t); const result = record(directory, fakeGrade);
  assert.deepEqual(result.usage, { input: 30, output: 10, cacheRead: 16, cacheWrite: 0, totalTokens: 56, reasoning: 4 });
  assert.equal(result.sessions.length, 2);
  assert.equal(result.coordination.team_actions['team_message:watch'], 2);
  assert.equal(result.environment.extensions[0].version, '0.0.0');
  assert.equal(result.timing.attempt_seconds, 12.345);
  assert.equal(result.api_equivalent_catalog_estimate_usd, null);
});
test('repeat record reuses matching snapshot grade without invoking grader twice', t => {
  const directory = fixture(t); let calls = 0;
  const grader = () => { calls++; return fakeGrade(); };
  record(directory, grader); record(directory, grader); assert.equal(calls, 1);
});
test('changed grader identity invalidates a matching-snapshot cache', t => {
  const directory = fixture(t); record(directory, fakeGrade); let calls = 0;
  record(directory, () => { calls++; return fakeGrade(); });
  assert.equal(calls, 1);
});
test('changed problem revision refuses silent regrading against new requirements', t => {
  const directory = fixture(t);
  write(join(directory, 'fixture-manifest.json'), { 'problems/event-delivery/PROMPT.md': 'outdated' });
  assert.throws(() => record(directory, fakeGrade), /Problem\/grader changed since attempt/);
});
test('changed snapshot refuses stale timing and grade', t => {
  const directory = fixture(t); record(directory, fakeGrade);
  writeFileSync(join(directory, 'submission', 'src.txt'), 'modified');
  assert.throws(() => record(directory, fakeGrade), /snapshot changed/);
});
test('missing environment or shutdown confirmation fails closed', t => {
  const directory = fixture(t); write(join(directory, 'shutdown.json'), { confirmed_exited: false });
  assert.throws(() => record(directory, fakeGrade), /shutdown is not confirmed/);
  write(join(directory, 'shutdown.json'), { confirmed_exited: true });
  rmSync(join(directory, 'environment.json'));
  assert.throws(() => record(directory, fakeGrade), /ENOENT/);
});
test('truncated transcript and inconsistent usage are errors, not silently missing tokens', t => {
  const directory = fixture(t);
  writeFileSync(join(directory, 'sessions', 'root.jsonl'), '{truncated');
  assert.throws(() => collectUsage(directory), /Invalid JSON/);
  write(join(directory, 'sessions', 'root.jsonl'), { message: { role: 'assistant', usage: { input: 10, totalTokens: 1 } } });
  assert.throws(() => collectUsage(directory), /totals disagree/);
});
test('active process using attempt session path prevents grading', async t => {
  const directory = fixture(t);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)', '--', '--session-dir', join(directory, 'sessions')]);
  await once(child, 'spawn');
  try { assert.throws(() => record(directory, fakeGrade), /agent still running/); }
  finally { child.kill('SIGTERM'); await once(child, 'exit'); }
});
test('new correctly structured eval directories are discovered without registry edits', t => {
  const directory = fixture(t); const problem = join(directory, 'third-problem');
  for (const path of ['fixture/src', 'fixture/test', 'reference/src', 'grader']) mkdirSync(join(problem, path), { recursive: true });
  writeFileSync(join(problem, 'PROMPT.md'), 'Contract');
  mkdirSync(join(directory, 'incomplete'));
  assert.deepEqual(discoverProblems(directory), ['third-problem']);
});
test('generic record runs actual unchanged delivery grader on reference snapshot', t => {
  const directory = fixture(t); const submission = join(directory, 'submission'); rmSync(submission, { recursive: true });
  const problem = new URL('./problems/event-delivery/', import.meta.url);
  cpSync(new URL('fixture/', problem), submission, { recursive: true });
  cpSync(new URL('reference/src/', problem), join(submission, 'src'), { recursive: true });
  write(join(directory, 'submission-manifest.json'), hashes(submission));
  const result = record(directory, grade);
  assert.equal(result.correctness.reward, 1);
  assert.equal(result.correctness.visible.passed, 15);
  assert.equal(result.correctness.additional.passed, 19);
  console.log(`Actual grading: ${result.timing.grading_seconds.toFixed(3)} seconds`);
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('./run.mjs', import.meta.url)), 'record', directory], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).usage.totalTokens, 56);
});
