import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { check, grade, prepare, problems } from './run.mjs';

const root = dirname(fileURLToPath(import.meta.url));

function temporary(run) {
  const directory = mkdtempSync(join(tmpdir(), 'ac-teams-eval-tool-test-'));
  try { return run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('simple v1 problem archive matches the original problem manifest', () => {
  const archive = join(root, 'history', 'simple-v1');
  const manifest = JSON.parse(readFileSync(join(archive, 'problem-manifest.json'), 'utf8'));
  assert.equal(Object.keys(manifest).length, 23);
  for (const [path, expected] of Object.entries(manifest)) {
    const actual = createHash('sha256').update(readFileSync(join(archive, 'problems', path))).digest('hex');
    assert.equal(actual, expected, `archived v1 file changed: ${path}`);
  }
});

test('preparation creates a fresh Git project without references or graders', () => temporary(directory => {
  const workspace = prepare('event-delivery', join(directory, 'work'));
  assert.ok(existsSync(join(workspace, '.git', 'HEAD')));
  assert.ok(existsSync(join(workspace, 'src', 'index.ts')));
  assert.ok(existsSync(join(workspace, 'test')));
  assert.equal(readFileSync(join(workspace, 'TASK.md'), 'utf8'), readFileSync(join(root, 'problems/event-delivery/PROMPT.md'), 'utf8'));
  assert.equal(existsSync(join(workspace, 'reference')), false);
  assert.equal(existsSync(join(workspace, 'grader')), false);
  assert.equal(existsSync(join(workspace, 'node_modules')), false);
}));

test('preparation rejects existing destinations, repository paths, and unknown problems', () => temporary(directory => {
  assert.throws(() => prepare('unknown', join(directory, 'unknown')), /Unknown problem/);
  assert.equal(existsSync(join(directory, 'unknown')), false);
  assert.throws(() => prepare('event-delivery', directory), /must not exist/);
  assert.throws(() => prepare('event-delivery', join(root, 'must-not-create')), /outside the AC Teams/);
  assert.equal(existsSync(join(root, 'must-not-create')), false);
}));

test('preparation does not inherit a parent Git repository override', () => temporary(directory => {
  const prior = process.env.GIT_DIR;
  try {
    process.env.GIT_DIR = join(directory, 'unrelated-missing.git');
    const workspace = prepare('event-delivery', join(directory, 'work'));
    assert.ok(existsSync(join(workspace, '.git', 'HEAD')));
    assert.equal(existsSync(process.env.GIT_DIR), false);
  } finally {
    if (prior === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = prior;
  }
}));

for (const name of problems) {
  test(`${name}: working starter is incomplete, reference satisfies every original check`, () => {
    const result = check(name);
    assert.equal(result.ok, true);
    assert.equal(result.starter.visible.ok, true);
    assert.equal(result.starter.additional.ok, false);
    assert.equal(result.starter.reward, 0);
    assert.equal(result.reference.visible.ok, true);
    assert.equal(result.reference.additional.ok, true);
    assert.equal(result.reference.reward, 1);
    assert.equal(existsSync(result.reference.workspace), false, 'check cleans its own temporary workspaces');
  });
}

test('grading uses submitted source and original tests, not submission-edited tests or npm scripts', () => temporary(directory => {
  const workspace = prepare('event-delivery', join(directory, 'work'));
  cpSync(join(root, 'problems/event-delivery/reference/src'), join(workspace, 'src'), { recursive: true });
  assert.equal(grade('event-delivery', workspace).reward, 1);
  writeFileSync(join(workspace, 'src/index.ts'), 'export function createDeliveryService() { throw new Error("broken submission"); }\n');
  for (const name of readdirSync(join(workspace, 'test'))) {
    if (name.endsWith('.test.ts')) writeFileSync(join(workspace, 'test', name), 'import test from "node:test"; test("fake pass", () => {});\n');
  }
  writeFileSync(join(workspace, 'package.json'), '{"type":"module","scripts":{"test":"exit 0"}}\n');
  const result = grade('event-delivery', workspace);
  assert.equal(result.reward, 0);
  assert.equal(result.visible.ok, false);
  assert.ok(result.visible.failed > 0);
  assert.equal(readdirSync(workspace).some(name => name.startsWith('.eval-visible-')), false);
}));
