import { expect, test } from 'bun:test';
import { probeOperatorInbox } from './operator-inbox';

test('posts, retrieves, and acknowledges one correlated message', async () => {
  const calls: string[] = [];
  const result = await probeOperatorInbox(
    {
      post: async id => {
        calls.push(`post:${id}`);
      },
      retrieve: async id => {
        calls.push(`retrieve:${id}`);
        return true;
      },
      acknowledge: async id => {
        calls.push(`ack:${id}`);
        return true;
      },
    },
    'fixed'
  );
  expect(result.verdict).toBe('passed');
  expect(calls).toEqual(['post:fixed', 'retrieve:fixed', 'ack:fixed']);
});

test('fails when the posted message cannot be read', async () => {
  const result = await probeOperatorInbox(
    { post: async () => {}, retrieve: async () => false, acknowledge: async () => true },
    'fixed'
  );
  expect(result.reasonCodes).toEqual(['operator_inbox_message_not_retrievable']);
});
