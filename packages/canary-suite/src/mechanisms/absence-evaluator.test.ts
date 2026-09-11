import { expect, test } from 'bun:test';
import { evaluateMechanismResult } from './absence-evaluator';
test('silent mechanism is a FAIL, not a pass', () => {
  expect(evaluateMechanismResult({ verdict: 'passed', reasonCodes: [], evidenceRefs: [] })).toEqual(
    { verdict: 'failed', reasonCodes: ['mechanism_silent'], evidenceRefs: [] }
  );
});
