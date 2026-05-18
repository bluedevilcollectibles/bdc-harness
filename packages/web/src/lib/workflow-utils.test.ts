import { describe, test, expect } from 'bun:test';
import { getNodeEvents, isTerminalStatus } from './workflow-utils';
import type { WorkflowEventResponse } from '@/lib/api';

function makeEvent(overrides: Partial<WorkflowEventResponse>): WorkflowEventResponse {
  return {
    id: overrides.id ?? 'evt-1',
    workflow_run_id: overrides.workflow_run_id ?? 'run-1',
    event_type: overrides.event_type ?? 'node_started',
    step_index: overrides.step_index ?? null,
    step_name: overrides.step_name ?? null,
    data: overrides.data ?? {},
    created_at: overrides.created_at ?? '2026-05-18T00:00:00Z',
  };
}

describe('isTerminalStatus', () => {
  test('completed is terminal', () => {
    expect(isTerminalStatus('completed')).toBe(true);
  });

  test('failed is terminal', () => {
    expect(isTerminalStatus('failed')).toBe(true);
  });

  test('cancelled is terminal', () => {
    expect(isTerminalStatus('cancelled')).toBe(true);
  });

  test('running is not terminal', () => {
    expect(isTerminalStatus('running')).toBe(false);
  });

  test('pending is not terminal', () => {
    expect(isTerminalStatus('pending')).toBe(false);
  });

  test('undefined is not terminal', () => {
    expect(isTerminalStatus(undefined)).toBe(false);
  });

  test('empty string is not terminal', () => {
    expect(isTerminalStatus('')).toBe(false);
  });
});

describe('getNodeEvents', () => {
  test('empty events array returns []', () => {
    expect(getNodeEvents([], 'plan')).toEqual([]);
  });

  test('filters to events matching nodeId only', () => {
    const events: WorkflowEventResponse[] = [
      makeEvent({ id: 'a', step_name: 'plan', event_type: 'node_started' }),
      makeEvent({ id: 'b', step_name: 'plan', event_type: 'tool_called' }),
      makeEvent({ id: 'c', step_name: 'plan', event_type: 'node_completed' }),
    ];
    const result = getNodeEvents(events, 'plan');
    expect(result.map(e => e.id)).toEqual(['a', 'b', 'c']);
  });

  test('excludes events for other nodes', () => {
    const events: WorkflowEventResponse[] = [
      makeEvent({ id: 'a', step_name: 'plan' }),
      makeEvent({ id: 'b', step_name: 'implement' }),
      makeEvent({ id: 'c', step_name: 'plan' }),
      makeEvent({ id: 'd', step_name: null }),
    ];
    const result = getNodeEvents(events, 'plan');
    expect(result.map(e => e.id)).toEqual(['a', 'c']);
  });

  test('preserves chronological order from input', () => {
    const events: WorkflowEventResponse[] = [
      makeEvent({ id: '1', step_name: 'plan', created_at: '2026-05-18T00:00:01Z' }),
      makeEvent({ id: '2', step_name: 'plan', created_at: '2026-05-18T00:00:02Z' }),
      makeEvent({ id: '3', step_name: 'plan', created_at: '2026-05-18T00:00:03Z' }),
    ];
    const result = getNodeEvents(events, 'plan');
    expect(result.map(e => e.created_at)).toEqual([
      '2026-05-18T00:00:01Z',
      '2026-05-18T00:00:02Z',
      '2026-05-18T00:00:03Z',
    ]);
  });

  test('returns [] when nodeId has no matches', () => {
    const events: WorkflowEventResponse[] = [
      makeEvent({ id: 'a', step_name: 'plan' }),
      makeEvent({ id: 'b', step_name: 'implement' }),
    ];
    expect(getNodeEvents(events, 'verify')).toEqual([]);
  });
});
