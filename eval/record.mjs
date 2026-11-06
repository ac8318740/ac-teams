import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

function parse(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${label}`, { cause: error });
  }
}

const read = path => parse(readFileSync(path, 'utf8'), path);

function atomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    if (entry.isFile() && entry.name.endsWith('.jsonl')) return [path];
    return [];
  }).sort();
}

function assertStopped(directory) {
  if (!read(join(directory, 'shutdown.json')).confirmed_exited) throw new Error('Session shutdown is not confirmed');
  // Corroborate the controller marker for native Pi sessions, without reading environment/credentials.
  if (!existsSync('/proc')) throw new Error('Native process verification requires /proc');
  const sessions = join(directory, 'sessions');
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let argv;
    try {
      argv = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0');
    } catch (error) {
      if (['ENOENT', 'EACCES', 'EPERM', 'ESRCH'].includes(error.code)) continue;
      throw error;
    }
    const index = argv.indexOf('--session-dir');
    if (index < 0 || !argv[index + 1]) continue;
    const path = relative(sessions, resolve(argv[index + 1]));
    if (path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep))) {
      throw new Error('Benchmark agent still running; refusing to grade');
    }
  }
}

export function collectUsage(directory) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoning: 0 };
  const sessions = [];
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let completeCost = true;
  const toolCalls = {};
  const teamActions = {};
  for (const path of files(join(directory, 'sessions'))) {
    const usage = Object.fromEntries(Object.keys(totals).map(key => [key, 0]));
    let requests = 0;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const message = parse(line, relative(directory, path)).message;
      if (message?.role !== 'assistant') continue;
      for (const item of Array.isArray(message.content) ? message.content : []) {
        if (item.type !== 'toolCall') continue;
        toolCalls[item.name] = (toolCalls[item.name] ?? 0) + 1;
        if (item.name?.startsWith('team_')) {
          const key = `${item.name}:${item.arguments?.action ?? 'unspecified'}`;
          teamActions[key] = (teamActions[key] ?? 0) + 1;
        }
      }
      if (!message.usage) continue;
      requests++;
      for (const key of Object.keys(usage)) {
        const value = message.usage[key] ?? 0;
        if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid usage: ${key}`);
        usage[key] += value;
      }
      const modelCost = message.usage.cost;
      if (!modelCost || !Object.keys(cost).every(key => Number.isFinite(modelCost[key]) && modelCost[key] >= 0)) {
        completeCost = false;
      } else {
        for (const key of Object.keys(cost)) cost[key] += modelCost[key];
      }
    }
    if (usage.totalTokens !== usage.input + usage.output + usage.cacheRead + usage.cacheWrite) {
      throw new Error('Usage totals disagree; refusing ambiguous token counts');
    }
    for (const key of Object.keys(totals)) totals[key] += usage[key];
    sessions.push({ transcript: relative(directory, path), requests, usage });
  }
  if (!sessions.length || !sessions.some(session => session.requests > 0)) throw new Error('No recorded model usage found');
  return {
    usage: totals,
    sessions,
    coordination: { tool_calls: toolCalls, team_actions: teamActions },
    api_equivalent_catalog_estimate_usd: completeCost ? cost : null,
  };
}

export function record(directory, grader) {
  directory = resolve(directory);
  const completion = read(join(directory, 'completion.json'));
  const environment = read(join(directory, 'environment.json'));
  if (!Array.isArray(environment.extensions) || !environment.extensions.length || !environment.runtime || !environment.model) {
    throw new Error('Missing extension/runtime/model manifest');
  }
  if (environment.extensions.some(extension => !extension.id || !extension.version || !extension.sha256)) {
    throw new Error('Incomplete extension version/fingerprint');
  }
  const timing = completion.result;
  if (!timing || !Number.isFinite(timing.attempt_seconds) || timing.attempt_seconds < 0) {
    throw new Error('Missing persisted completion timing');
  }
  assertStopped(directory);
  const metrics = collectUsage(directory);
  const submission = join(directory, 'submission');
  if (!existsSync(submission)) throw new Error('Missing immutable submission snapshot; finish session cleanup first');
  const expected = read(join(directory, 'submission-manifest.json'));
  const actual = {};
  function fingerprint(path, base = submission, output = actual) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) fingerprint(child, base, output);
      else if (entry.isFile()) output[relative(base, child)] = createHash('sha256').update(readFileSync(child)).digest('hex');
      else throw new Error('Unexpected non-file in submission snapshot');
    }
  }
  fingerprint(submission);
  if (Object.keys(actual).length !== Object.keys(expected).length || Object.entries(actual).some(([path, hash]) => expected[path] !== hash)) {
    throw new Error('Submission snapshot changed; refusing stale timing/grade');
  }
  if (!/^[a-z][a-z0-9-]*$/.test(completion.task)) throw new Error('Invalid problem name');
  const problemRoot = fileURLToPath(new URL(`./problems/${completion.task}/`, import.meta.url));
  const problemFiles = {};
  fingerprint(problemRoot, problemRoot, problemFiles);
  if (existsSync(join(directory, 'fixture-manifest.json'))) {
    const before = read(join(directory, 'fixture-manifest.json'));
    const prefix = `problems/${completion.task}/`;
    if (Object.keys(before).length !== Object.keys(problemFiles).length || Object.entries(problemFiles).some(([path, hash]) => before[prefix + path] !== hash)) {
      throw new Error('Problem/grader changed since attempt; use its matching revision');
    }
  }
  const graderFingerprint = createHash('sha256')
    .update(JSON.stringify(Object.entries(problemFiles).sort()))
    .update(readFileSync(new URL('./run.mjs', import.meta.url)))
    .update(readFileSync(new URL('./record.mjs', import.meta.url)))
    .update(grader.toString())
    .digest('hex');
  const started = performance.now();
  const cachePath = join(directory, 'grade-complete.json');
  const previous = existsSync(cachePath) ? read(cachePath) : null;
  const cached = previous?.grader_fingerprint === graderFingerprint ? previous : null;
  const grade = cached?.grade ?? grader(completion.task, submission);
  const gradingSeconds = cached?.verifier_seconds ?? (performance.now() - started) / 1000;
  if (!Number.isFinite(gradingSeconds) || gradingSeconds < 0) throw new Error('Invalid grader timing');
  if (!cached) atomic(cachePath, { grade, verifier_seconds: gradingSeconds, grader_fingerprint: graderFingerprint });
  const result = {
    schema_version: 1,
    problem: completion.task,
    attempt: { status: timing.status ?? 'unknown', valid_trial: timing.valid_trial ?? null },
    correctness: {
      reward: grade.reward,
      visible: { tests: grade.visible.tests, passed: grade.visible.passed, failed: grade.visible.failed },
      additional: { tests: grade.additional.tests, passed: grade.additional.passed, failed: grade.additional.failed },
    },
    timing: {
      attempt_seconds: timing.attempt_seconds,
      root_attempt_seconds: timing.root_attempt_seconds ?? null,
      descendant_settle_seconds: timing.descendant_settle_seconds ?? null,
      grading_seconds: gradingSeconds,
      recovery: timing.timing_recovery ?? null,
    },
    ...metrics,
    environment,
    problem_files_sha256: problemFiles,
    grader_fingerprint: graderFingerprint,
    selected_extensions_by_member: existsSync(join(directory, 'members-safe.json'))
      ? read(join(directory, 'members-safe.json')).map(member => ({
        id: member.id,
        name: member.name ?? null,
        preset: member.extensions?.preset ?? null,
        extension_ids: member.extensions?.ids ?? [],
      }))
      : [],
    source: {
      candidate_freeze_sha256sum: timing.candidate_freeze_sha256sum ?? null,
      candidate_source_files_sha256: timing.candidate_source_files_sha256 ?? null,
      source_unchanged: timing.candidate_unchanged ?? null,
      plugins_unchanged: timing.plugins_unchanged ?? null,
    },
    caveats: [
      'Whole-team usage includes all recorded root/child sessions. Reasoning is already in output, not added twice.',
      'Catalog API estimates are not actual subscription charges. Supervisor usage is excluded.',
      'Native execution is not an OS sandbox or resource-isolated.',
    ],
  };
  atomic(join(directory, 'grade.json'), grade);
  atomic(join(directory, 'record.json'), result);
  return result;
}
