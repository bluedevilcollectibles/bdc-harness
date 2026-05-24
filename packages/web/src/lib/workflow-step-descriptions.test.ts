import { describe, expect, test } from 'bun:test';
import { getWorkflowStepHelp } from './workflow-step-descriptions';

describe('getWorkflowStepHelp', () => {
  test('describes read-spec nodes as work-order loading', () => {
    expect(getWorkflowStepHelp({ nodeId: 'read-spec', nodeType: 'bash' })).toEqual({
      title: 'Read the work order',
      body: 'Loads the approved spec and turns the human request into the run context the agents will follow.',
    });
  });

  test('describes implementation nodes as build work', () => {
    expect(
      getWorkflowStepHelp({ nodeId: 'implement', label: 'Major Build', nodeType: 'prompt' })
    ).toEqual({
      title: 'Build the change',
      body: 'Applies the requested code, docs, or configuration changes inside the target repo.',
    });
  });

  test('falls back to persona-aware copy for unknown node types', () => {
    expect(
      getWorkflowStepHelp({
        nodeId: 'custom-risk-review',
        agentPersona: 'war-council-architect',
      })
    ).toEqual({
      title: 'Step: custom risk review',
      body: 'Runs with the war-council-architect persona for this part of the workflow.',
    });
  });
});
