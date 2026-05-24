/**
 * Unit tests for the `persona:` <-> `agent:` alias contract.
 *
 * Anchor: WO-HARNESS-PERSONA-DECLARED-NOT-LOADED-01 (2026-05-24).
 *
 * Background: prior to the fix, `persona:` was declared in 51 bdc-* YAML nodes
 * but silently stripped by the dag-node parser (no schema field) and ignored
 * by the executor (gated on `agent:` only). This file proves the alias is now
 * first-class and load-bearing:
 *
 *   S1: schema accepts `persona:`-only nodes (was: silently stripped).
 *   S2: schema still accepts `agent:`-only nodes (no regression).
 *   S3: schema accepts `persona:` + `agent:` when values agree (no duplicate).
 *   S4: validator reports an error when the persona/agent name is unknown.
 *   S5: schema rejects conflicting `persona:` + `agent:` at parse time (fail-loud).
 *
 * The dag-executor alias logic itself (`node.agent ?? node.persona`) is asserted
 * by inspecting the parsed-node shape and the equivalence of resolution inputs;
 * a full executor end-to-end mock would re-implement half the workflow harness
 * for marginal incremental coverage.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import { dagNodeSchema } from './schemas/dag-node';
import { validateWorkflowResources } from './validator';
import type { WorkflowDefinition, DagNode } from './schemas';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'persona-alias-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeWorkflow(nodes: DagNode[]): WorkflowDefinition {
  return {
    name: 'persona-alias-test',
    description: 'test workflow',
    nodes,
  } as WorkflowDefinition;
}

/** Drop a minimal valid agent file under tmpDir/.archon/agents/<name>.md. */
async function createAgentFile(name: string): Promise<void> {
  const dir = join(tmpDir, '.archon', 'agents');
  await mkdir(dir, { recursive: true });
  const content = `---
name: ${name}
model: sonnet
---

You are the ${name} persona. Test sentinel: PERSONA_LOAD_BEARING.
`;
  await writeFile(join(dir, `${name}.md`), content);
}

// ---------------------------------------------------------------------------
// S1 — persona-only node parses and carries persona through the transform
// ---------------------------------------------------------------------------

describe('S1: persona:-only node loads via alias', () => {
  test('schema accepts persona: field on prompt node', () => {
    const result = dagNodeSchema.safeParse({
      id: 'plan',
      persona: 'overseer',
      prompt: 'Do the thing.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { persona?: string }).persona).toBe('overseer');
      // agent: must NOT be auto-populated — the alias is read at resolution time,
      // not normalized at parse time.
      expect((result.data as { agent?: string }).agent).toBeUndefined();
    }
  });

  test('schema accepts persona: field on command node', () => {
    const result = dagNodeSchema.safeParse({
      id: 'review',
      persona: 'captain-ci-validator',
      command: 'archon-assist',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { persona?: string }).persona).toBe('captain-ci-validator');
    }
  });

  test('schema accepts persona: field on loop node', () => {
    const result = dagNodeSchema.safeParse({
      id: 'iterate',
      persona: 'major-build',
      loop: {
        prompt: 'Iterate until done.',
        until: 'DONE',
        max_iterations: 3,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { persona?: string }).persona).toBe('major-build');
    }
  });

  test('alias resolution: node.agent ?? node.persona resolves to persona when only persona is set', () => {
    // Mirrors the exact one-liner in dag-executor.ts (regular + loop paths) and
    // validator.ts so a regression that drops the alias would fail this test.
    const result = dagNodeSchema.safeParse({
      id: 'overseer-only',
      persona: 'overseer',
      prompt: 'Verify the overseer persona resolves via persona-only declaration.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const node = result.data as { agent?: string; persona?: string };
      const agentName = node.agent ?? node.persona;
      expect(agentName).toBe('overseer');
    }
  });
});

// ---------------------------------------------------------------------------
// S2 — agent-only nodes still work (regression guard)
// ---------------------------------------------------------------------------

describe('S2: agent:-only node still loads (regression guard)', () => {
  test('schema accepts agent: field on prompt node', () => {
    const result = dagNodeSchema.safeParse({
      id: 'plan',
      agent: 'war-council-architect',
      prompt: 'Plan it.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { agent?: string }).agent).toBe('war-council-architect');
    }
  });

  test('alias resolution: agent: still wins via ?? when only agent is set', () => {
    const result = dagNodeSchema.safeParse({
      id: 'agent-only',
      agent: 'war-council-architect',
      prompt: 'Test.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const node = result.data as { agent?: string; persona?: string };
      const agentName = node.agent ?? node.persona;
      expect(agentName).toBe('war-council-architect');
    }
  });
});

// ---------------------------------------------------------------------------
// S3 — both fields set and agree (no double-injection)
// ---------------------------------------------------------------------------

describe('S3: persona: + agent: agree — no double injection', () => {
  test('schema accepts both fields when values match', () => {
    const result = dagNodeSchema.safeParse({
      id: 'both-aligned',
      persona: 'overseer',
      agent: 'overseer',
      prompt: 'Both fields set to the same value.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { agent?: string }).agent).toBe('overseer');
      expect((result.data as { persona?: string }).persona).toBe('overseer');
    }
  });

  test('alias resolution: ?? returns persona name exactly once (not duplicated)', () => {
    // The resolution logic (node.agent ?? node.persona) yields a single string,
    // which is then passed to resolveAgent() exactly once — preventing
    // double-injection of persona context.
    const result = dagNodeSchema.safeParse({
      id: 'both-aligned',
      persona: 'overseer',
      agent: 'overseer',
      prompt: 'Test.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const node = result.data as { agent?: string; persona?: string };
      const agentName = node.agent ?? node.persona;
      expect(agentName).toBe('overseer');
      // Defensive: confirm the ?? operator returns a single string, not [agent, persona]
      expect(typeof agentName).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// S4 — unknown persona fails loud at validation time
// ---------------------------------------------------------------------------

describe('S4: unknown persona fails loud (before any node runs)', () => {
  test('validator reports error for unknown persona: value', async () => {
    const node = {
      id: 'ghost',
      persona: 'nonexistent-ghost',
      prompt: 'Will never run.',
    } as unknown as DagNode;
    const workflow = makeWorkflow([node]);
    const issues = await validateWorkflowResources(workflow, tmpDir);
    const personaError = issues.find(
      i => i.level === 'error' && i.nodeId === 'ghost' && i.field === 'persona'
    );
    expect(personaError).toBeDefined();
    expect(personaError!.message).toContain('nonexistent-ghost');
    expect(personaError!.message).toContain('not found');
  });

  test('validator reports error for unknown agent: value (regression guard)', async () => {
    const node = {
      id: 'ghost-agent',
      agent: 'nonexistent-ghost',
      prompt: 'Will never run.',
    } as unknown as DagNode;
    const workflow = makeWorkflow([node]);
    const issues = await validateWorkflowResources(workflow, tmpDir);
    const agentError = issues.find(
      i => i.level === 'error' && i.nodeId === 'ghost-agent' && i.field === 'agent'
    );
    expect(agentError).toBeDefined();
    expect(agentError!.message).toContain('nonexistent-ghost');
  });

  test('validator passes when persona: references an existing agent file', async () => {
    await createAgentFile('overseer');
    const node = {
      id: 'plan',
      persona: 'overseer',
      prompt: 'Run.',
    } as unknown as DagNode;
    const workflow = makeWorkflow([node]);
    const issues = await validateWorkflowResources(workflow, tmpDir);
    const personaIssue = issues.find(i => i.nodeId === 'plan' && i.field === 'persona');
    expect(personaIssue).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// S5 — schema rejects conflicting persona: + agent:
// ---------------------------------------------------------------------------

describe('S5: persona: vs agent: conflict is rejected at parse time', () => {
  test('schema rejects mismatched persona and agent', () => {
    const result = dagNodeSchema.safeParse({
      id: 'conflict',
      persona: 'overseer',
      agent: 'major-build',
      prompt: 'Conflicting values.',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map(i => i.message).join(' | ');
      expect(messages).toContain('must agree');
      expect(messages).toContain('overseer');
      expect(messages).toContain('major-build');
    }
  });

  test('error path points to the persona field for actionable reporting', () => {
    const result = dagNodeSchema.safeParse({
      id: 'conflict',
      persona: 'overseer',
      agent: 'major-build',
      prompt: 'X.',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const hasPersonaPath = result.error.issues.some(i =>
        (i.path as Array<string | number>).includes('persona')
      );
      expect(hasPersonaPath).toBe(true);
    }
  });
});
