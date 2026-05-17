/**
 * Verifies persona: declarations across bdc-* workflow YAMLs reference
 * agents that actually exist in .archon/agents/.
 *
 * Anchor: 2026-05-17 retrofit. Without this test, a YAML can declare
 * persona: X where X doesn't exist, and the runtime fails opaquely.
 */
import { test, expect } from 'bun:test';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';

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
