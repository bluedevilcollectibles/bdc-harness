import {
  appendDeliveryReceipt,
  claimDueDeliveryJob,
  completeDeliveryJob,
  getOperatorCard,
  type DeliveryJobRecord,
  type DeliveryOutcome,
  type OperatorCardChannelName,
  type OperatorCardView,
} from '@archon/core/db/overseer-briefing';
import { createAuthenticatedMessage } from '@archon/core/db/dispatch';
import { assessDispatchMessageBody } from '@archon/core/utils/dispatch-content-guard';
import { buildDispatchRunReportBody } from './escalate';
import { resolveWoBoardSeatOwner } from './owner-resolution';

export interface ChannelDeliveryResult {
  outcome: DeliveryOutcome;
  sanitized_status: string;
  error_class?: string | null;
  provider_receipt_id?: string | null;
}

export interface OperatorCardChannel {
  channel: OperatorCardChannelName;
  deliver(card: OperatorCardView, idempotencyKey: string): Promise<ChannelDeliveryResult>;
  reconcile(card: OperatorCardView, attempt: number): Promise<ChannelDeliveryResult>;
}

export interface DeliveryStore {
  claimDueDeliveryJob: typeof claimDueDeliveryJob;
  getOperatorCard: typeof getOperatorCard;
  appendDeliveryReceipt: typeof appendDeliveryReceipt;
  completeDeliveryJob: typeof completeDeliveryJob;
}

export interface OperatorCardChannelDeps {
  fetch: typeof fetch;
  builder_monitor_url: string;
  resolve_owner: (woId: string) => Promise<string | null>;
}

const defaultStore: DeliveryStore = {
  claimDueDeliveryJob,
  getOperatorCard,
  appendDeliveryReceipt,
  completeDeliveryJob,
};

const DEFAULT_BUILDER_MONITOR_URL = 'https://n8n.bluedevilcollectibles.com/webhook/builder-status';

function classifyHttpFailure(status: number, channel: string): ChannelDeliveryResult {
  if (status >= 500 && status <= 599) {
    return {
      outcome: 'indeterminate',
      sanitized_status: `${channel}_provider_state_unknown`,
      error_class: `http_${status}`,
    };
  }
  const retrySafe = status === 429;
  return {
    outcome: retrySafe ? 'transient_failure' : 'permanent_failure',
    sanitized_status: retrySafe ? `${channel}_retryable` : `${channel}_rejected`,
    error_class: `http_${status}`,
  };
}

export function createDefaultOperatorCardChannels(
  overrides: Partial<OperatorCardChannelDeps> = {}
): OperatorCardChannel[] {
  const deps: OperatorCardChannelDeps = {
    fetch: overrides.fetch ?? globalThis.fetch,
    builder_monitor_url:
      overrides.builder_monitor_url ??
      process.env.BUILDER_MONITOR_WEBHOOK_URL ??
      DEFAULT_BUILDER_MONITOR_URL,
    resolve_owner: overrides.resolve_owner ?? resolveWoBoardSeatOwner,
  };

  const dispatch: OperatorCardChannel = {
    channel: 'dispatch',
    deliver: async (card, idempotencyKey) => {
      const body = buildDispatchRunReportBody(card.card);
      const assessment = assessDispatchMessageBody('run_report', body);
      if (!assessment.allowed) {
        return {
          outcome: 'permanent_failure',
          sanitized_status: 'dispatch_content_rejected',
          error_class: assessment.reason ?? 'content_guard_rejected',
        };
      }
      const message = await createAuthenticatedMessage(
        { kind: 'system', sender: 'overseer' },
        {
          correlation_id: card.card.run_id,
          idempotency_key: idempotencyKey,
          task_type: 'run_report',
          recipient: (await deps.resolve_owner(card.card.wo_id)) ?? 'operator',
          body,
        }
      );
      return {
        outcome: 'succeeded',
        sanitized_status: 'dispatch_queued',
        provider_receipt_id: message.id,
      };
    },
    reconcile: async card => dispatch.deliver(card, `operator-card:${card.card.card_id}:dispatch`),
  };

  const builderMonitor: OperatorCardChannel = {
    channel: 'builder_monitor',
    deliver: async card => {
      const response = await deps.fetch(deps.builder_monitor_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          builder: 'Cauldron',
          wo_id: card.card.wo_id,
          action: 'needs_human',
          detail: card.card.blocker,
          card_id: card.card.card_id,
        }),
      });
      return response.ok
        ? { outcome: 'succeeded', sanitized_status: 'builder_monitor_accepted' }
        : classifyHttpFailure(response.status, 'builder_monitor');
    },
    reconcile: async () => ({
      outcome: 'indeterminate',
      sanitized_status: 'builder_monitor_provider_state_unknown',
    }),
  };

  const notion: OperatorCardChannel = {
    channel: 'notion',
    deliver: async () => ({
      outcome: 'permanent_failure',
      sanitized_status: 'notion_channel_retired',
      error_class: 'notion_escalation_retired',
    }),
    reconcile: async () => ({
      outcome: 'permanent_failure',
      sanitized_status: 'notion_channel_retired',
      error_class: 'notion_escalation_retired',
    }),
  };
  return [dispatch, builderMonitor, notion];
}

function normalizeResult(result: ChannelDeliveryResult): ChannelDeliveryResult {
  if (
    ['succeeded', 'transient_failure', 'permanent_failure', 'indeterminate'].includes(
      result.outcome
    )
  ) {
    return result;
  }
  return {
    outcome: 'indeterminate',
    sanitized_status: 'channel_returned_invalid_outcome',
    error_class: 'invalid_channel_result',
  };
}

function hasUnfinishedStartedReceipt(card: OperatorCardView, job: DeliveryJobRecord): boolean {
  const matches = card.receipts.filter(
    receipt => receipt.channel === job.channel && receipt.attempt_number === job.attempts_started
  );
  return (
    matches.some(receipt => receipt.phase === 'started') &&
    !matches.some(receipt => receipt.phase === 'terminal')
  );
}

export async function deliverOperatorCard(input: {
  job: DeliveryJobRecord;
  channel: OperatorCardChannel;
  owner: string;
  now: string;
  store?: DeliveryStore;
}): Promise<DeliveryJobRecord> {
  const store = input.store ?? defaultStore;
  const card = await store.getOperatorCard(input.job.card_id);
  if (!card) throw new Error('operator_card_not_found');
  const priorTerminal = card.receipts.find(
    receipt =>
      receipt.channel === input.job.channel &&
      receipt.attempt_number === input.job.attempts_started &&
      receipt.phase === 'terminal'
  );
  if (priorTerminal?.outcome) {
    return store.completeDeliveryJob({
      card_id: input.job.card_id,
      channel: input.job.channel,
      owner: input.owner,
      fencing_token: input.job.fencing_token,
      outcome: priorTerminal.outcome,
      now: input.now,
    });
  }
  const recovering = hasUnfinishedStartedReceipt(card, input.job);

  if (!recovering) {
    await store.appendDeliveryReceipt({
      card_id: input.job.card_id,
      channel: input.job.channel,
      attempt_number: input.job.attempts_started,
      phase: 'started',
      started_at: input.now,
      fencing_token: input.job.fencing_token,
      lease_owner: input.owner,
    });
  }

  let result: ChannelDeliveryResult;
  try {
    result = normalizeResult(
      recovering
        ? await input.channel.reconcile(card, input.job.attempts_started)
        : await input.channel.deliver(
            card,
            `operator-card:${input.job.card_id}:${input.job.channel}`
          )
    );
  } catch {
    result = recovering
      ? {
          outcome: 'indeterminate',
          sanitized_status: 'reconciliation_failed_unknown_provider_state',
          error_class: 'reconciliation_failed',
        }
      : {
          outcome: 'indeterminate',
          sanitized_status: 'channel_transport_state_unknown',
          error_class: 'response_state_unknown',
        };
  }

  const nextAttemptAt =
    result.outcome === 'transient_failure' && input.job.attempts_started < 3
      ? new Date(
          new Date(card.card.created_at).getTime() +
            (input.job.attempts_started === 1 ? 30_000 : 120_000)
        ).toISOString()
      : null;
  await store.appendDeliveryReceipt({
    card_id: input.job.card_id,
    channel: input.job.channel,
    attempt_number: input.job.attempts_started,
    phase: 'terminal',
    started_at: input.now,
    completed_at: input.now,
    outcome: result.outcome,
    sanitized_status: result.sanitized_status,
    error_class: result.error_class ?? null,
    next_attempt_at: nextAttemptAt,
    provider_receipt_id: result.provider_receipt_id ?? null,
    fencing_token: input.job.fencing_token,
    lease_owner: input.owner,
  });
  return store.completeDeliveryJob({
    card_id: input.job.card_id,
    channel: input.job.channel,
    owner: input.owner,
    fencing_token: input.job.fencing_token,
    outcome: result.outcome,
    now: input.now,
  });
}

export async function runDueOperatorCardDeliveries(input: {
  channels: OperatorCardChannel[];
  owner: string;
  now?: string;
  max_jobs?: number;
  store?: DeliveryStore;
}): Promise<DeliveryJobRecord[]> {
  const store = input.store ?? defaultStore;
  const now = input.now ?? new Date().toISOString();
  const channels = new Map(input.channels.map(channel => [channel.channel, channel]));
  const completed: DeliveryJobRecord[] = [];
  for (let count = 0; count < (input.max_jobs ?? 100); count += 1) {
    const job = await store.claimDueDeliveryJob({ owner: input.owner, now });
    if (!job) break;
    const channel = channels.get(job.channel);
    if (!channel) throw new Error(`operator_card_channel_missing:${job.channel}`);
    completed.push(await deliverOperatorCard({ job, channel, owner: input.owner, now, store }));
  }
  return completed;
}
