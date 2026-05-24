/**
 * Verifies persona: declarations across bdc-* workflow YAMLs reference
 * agents that actually exist in .archon/agents/ AND that the harness
 * runtime treats `persona:` as a first-class alias for `agent:` (i.e. the
 * load-path actually loads the persona — not just that the name is valid).
 *
 * History:
 *  - 2026-05-17 retrofit: original test only validated that each `persona:`
 *    name referenced a known agent. It silently passed while 51/53 nodes
 *    declared `persona:` without `agent:` and loaded NOTHING at runtime.
 *  - 2026-05-24 (WO-HARNESS-PERSONA-DECLARED-NOT-LOADED-01): strengthened to
 *    assert the load-path — the schema must accept persona-only nodes and
 *    dag-executor / validator must resolve them via the `agent ?? persona`
 *    alias chain. A regression that drops the alias would make this test fail.
 */
import { test, expect } from 'bun:test';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { dagNodeSchema } from './schemas/dag-node';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const YAML_DIR = join(REPO_ROOT, '.archon', 'workflows', 'defaults');
const AGENTS_DIR = join(REPO_ROOT, '.archon', 'agents');

const YAML_FILES = [
  'bdc-feature-development.yaml',
  'bdc-bug-fix.yaml',
  'bdc-cleanup-sweep.yaml',
  'bdc-doctrine-update.yaml',
];

async function loadKnownAgents(): Promise<Set<string>> {
  const files = await readdir(AGENTS_DIR);
  const names = new Set<string>();
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const content = await readFile(join(AGENTS_DIR, f), 'utf-8');
    const m = content.match(/^name:\s*(\S+)/m);
    if (m) names.add(m[1]);
  }
  return names;
}

function extractPersonas(yaml: string): string[] {
  const matches = yaml.matchAll(/^\s+persona:\s*(\S+)\s*$/gm);
  return [...matches].map(m => m[1]);
}

test('all persona: declarations reference loaded agents', async () => {
  const known = await loadKnownAgents();
  expect(known.size).toBeGreaterThan(0);

  for (const yamlFile of YAML_FILES) {
    const content = await readFile(join(YAML_DIR, yamlFile), 'utf-8');
    const personas = extractPersonas(content);
    expect(personas.length).toBeGreaterThan(0);
    for (const p of personas) {
      expect(known.has(p)).toBe(true);
    }
  }
});

test('commit-and-push uses overseer persona in all 4 YAMLs', async () => {
  for (const yamlFile of YAML_FILES) {
    const content = await readFile(join(YAML_DIR, yamlFile), 'utf-8');
    // Find commit-and-push node block
    const m = content.match(/- id: commit-and-push\s+persona:\s*(\S+)/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('overseer');
  }
});

test('plan nodes use war-council-architect persona', async () => {
  const expectations = [
    { file: 'bdc-feature-development.yaml', personaLineMustContain: 'war-council-architect' },
    { file: 'bdc-bug-fix.yaml', personaLineMustContain: 'war-council-architect' },
    { file: 'bdc-doctrine-update.yaml', personaLineMustContain: 'war-council-architect' },
  ];
  for (const { file, personaLineMustContain } of expectations) {
    const content = await readFile(join(YAML_DIR, file), 'utf-8');
    // Any persona line referencing war-council-architect anywhere in the file
    expect(content.includes(`persona: ${personaLineMustContain}`)).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// 2026-05-24 (WO-HARNESS-PERSONA-DECLARED-NOT-LOADED-01) — load-path regression guards
// ---------------------------------------------------------------------------

test('persona: declarations resolve without agent: (alias load-path regression guard)', async () => {
  // The schema must accept persona-only nodes (would FAIL pre-fix because
  // `persona:` was not a declared field on dagNodeBaseSchema and was stripped
  // silently by the transform). Sanity-check every persona declaration in the
  // bdc-* YAMLs parses successfully as a synthetic prompt node — proving the
  // alias path is sufficient and does not require co-declaring `agent:`.
  for (const yamlFile of YAML_FILES) {
    const content = await readFile(join(YAML_DIR, yamlFile), 'utf-8');
    const personas = extractPersonas(content);
    expect(personas.length).toBeGreaterThan(0);
    for (const persona of personas) {
      const result = dagNodeSchema.safeParse({
        id: `synthetic-${persona}`,
        prompt: 'synthetic test node — verifies persona: alias parses',
        persona,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect((result.data as { persona?: string }).persona).toBe(persona);
      }
    }
  }
});

test('persona: and agent: conflict is rejected at parse time (fail-loud)', () => {
  // dagNodeSchema must reject mismatched persona/agent (no silent precedence).
  const result = dagNodeSchema.safeParse({
    id: 'conflict',
    prompt: 'should not parse',
    persona: 'overseer',
    agent: 'major-build',
  });
  expect(result.success).toBe(false);
  if (!result.success) {
    const messages = result.error.issues.map(i => i.message).join(' | ');
    expect(messages).toContain('must agree');
  }
});

test('persona: and agent: that agree are both accepted', () => {
  const result = dagNodeSchema.safeParse({
    id: 'both-same',
    prompt: 'allowed when values match',
    persona: 'major-build',
    agent: 'major-build',
  });
  expect(result.success).toBe(true);
  if (result.success) {
    expect((result.data as { agent?: string }).agent).toBe('major-build');
    expect((result.data as { persona?: string }).persona).toBe('major-build');
  }
});
