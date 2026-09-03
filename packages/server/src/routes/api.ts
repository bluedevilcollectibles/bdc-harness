/**
 * REST API routes for the Archon Web UI.
 * Provides conversation, codebase, and SSE streaming endpoints.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import { cors } from 'hono/cors';
import type { WebAdapter } from '../adapters/web';
import { rm, readFile, writeFile, unlink, mkdir } from 'fs/promises';
import { readFileSync } from 'fs';
import { normalize, join, sep, basename } from 'path';
import { randomUUID } from 'crypto';
import type { Context } from 'hono';
import type {
  ConversationLockManager,
  AttachedFile,
  HandleMessageContext,
  GlobalConfig,
} from '@archon/core';
import {
  handleMessage,
  getDatabaseType,
  loadConfig,
  toSafeConfig,
  updateGlobalConfig,
  cloneRepository,
  registerRepository,
  ConversationNotFoundError,
  generateAndSetTitle,
} from '@archon/core';
import { createWorkflowDeps } from '@archon/core/workflows';
import { runCascade } from '@archon/smart-cauldron/cascade';
import {
  readCascadeRecordById,
  claimFrontierResolution,
  releaseFrontierClaim,
  resumeFrontierTier,
  rejectFrontierTier,
} from '@archon/smart-cauldron/frontier-approval';
import { removeWorktree, toRepoPath, toWorktreePath } from '@archon/git';
import {
  createLogger,
  getWorkflowFolderSearchPaths,
  getCommandFolderSearchPaths,
  getDefaultCommandsPath,
  getDefaultWorkflowsPath,
  getArchonWorkspacesPath,
  getHomeCommandsPath,
  getRunArtifactsPath,
  getArchonHome,
  isDocker,
  checkForUpdate,
  BUNDLED_IS_BINARY,
  BUNDLED_VERSION,
} from '@archon/paths';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { resolveWorkflowName } from '@archon/workflows/router';
import { parseWorkflowRunBranchOverride } from './workflow-run-branch-override';
import { extractWoIdFromMessage, findLiveRunsForWo, isCascadeClimbMessage } from './wo-fire-guard';
import type { WorkflowDefinition } from '@archon/workflows/schemas/workflow';
import { executeWorkflow } from '@archon/workflows/executor';
import { checkCodexDispatchGate } from '@archon/providers/auth-refresh/dispatch-gate';
import { processDueProviderWaits } from '@archon/workflows/reliability/wait-scheduler';
import { resolveWorkflowProbeBindings } from '@archon/workflows/reliability/resolve-binding';
import { getLoaderErrors, parseWorkflow } from '@archon/workflows/loader';
import { isValidCommandName } from '@archon/workflows/command-validation';
import { BUNDLED_WORKFLOWS, BUNDLED_COMMANDS, isBinaryBuild } from '@archon/workflows/defaults';
import { resolveWebLane } from '../adapters/web/workflow-bridge';
import {
  RESUMABLE_WORKFLOW_STATUSES,
  TERMINAL_WORKFLOW_STATUSES,
} from '@archon/workflows/schemas/workflow-run';
import type { ApprovalContext, WorkflowRun } from '@archon/workflows/schemas/workflow-run';
import { findMarkdownFilesRecursive } from '@archon/core/utils/commands';
import { startTaskmaster, getTaskmasterRuntime, getTickHealth } from '../taskmaster/loop';
import { startTaskmasterDeadmanChecker } from '@archon/overseer/taskmaster-deadman-check';
import { startOperatorInboxConsumer } from '../dispatch/operator-inbox-consumer';
import {
  taskmasterStatusResponseSchema,
  taskmasterPauseBodySchema,
  taskmasterResumeBodySchema,
  taskmasterControlResponseSchema,
  registerListQuerySchema,
  registerListResponseSchema,
  registerMetaResponseSchema,
} from './schemas/taskmaster.schemas';

const parsedRegisterStaleAfterMs = Number.parseInt(
  process.env.TASKMASTER_REGISTER_STALE_AFTER_MS ?? '',
  10
);
export const REGISTER_STALE_AFTER_MS =
  Number.isInteger(parsedRegisterStaleAfterMs) && parsedRegisterStaleAfterMs >= 0
    ? parsedRegisterStaleAfterMs
    : 120_000;

let providerWaitSchedulerTimer: ReturnType<typeof setInterval> | undefined;

export function stopProviderWaitScheduler(): void {
  if (providerWaitSchedulerTimer) clearInterval(providerWaitSchedulerTimer);
  providerWaitSchedulerTimer = undefined;
}

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('api');
  return cachedLog;
}

async function rejectKnownBadWorkflowBinding(
  workflow: WorkflowDefinition,
  cwd: string
): Promise<string | null> {
  const config = await loadConfig(cwd);
  const assistants = config.assistants ?? { claude: {}, codex: {} };
  const workflowProvider = workflow.provider ?? config.assistant ?? 'claude';
  const assistantDefaults = assistants[workflowProvider];
  const workflowModel =
    workflow.model ?? (assistantDefaults?.model as string | undefined) ?? 'claude-sonnet-4-5';
  let bindings: ReturnType<typeof resolveWorkflowProbeBindings>;
  try {
    bindings = resolveWorkflowProbeBindings({
      workflow,
      workflowProvider,
      workflowModel,
      config: { ...config, assistant: workflowProvider, assistants },
    });
  } catch (error) {
    getLog().warn(
      { err: error as Error, workflowName: workflow.name },
      'workflow.known_bad_binding_resolution_skipped'
    );
    return null;
  }
  for (const binding of bindings) {
    if (!binding.bindingKey) continue;
    const active = await knownBadBindingsDb.findActiveByBindingKey(binding.bindingKey);
    if (active) {
      return `known_bad_binding:${active.provider_id}:${active.model_id}:${active.error_body_excerpt}`;
    }
  }
  return null;
}
import * as conversationDb from '@archon/core/db/conversations';
import * as codebaseDb from '@archon/core/db/codebases';
import * as envVarDb from '@archon/core/db/env-vars';
import * as isolationEnvDb from '@archon/core/db/isolation-environments';
import * as workflowDb from '@archon/core/db/workflows';
import * as taskmasterDb from '@archon/core/db/taskmaster';
import * as workflowEventDb from '@archon/core/db/workflow-events';
import * as messageDb from '@archon/core/db/messages';
import * as dispatchDb from '@archon/core/db/dispatch';
import * as knownBadBindingsDb from '@archon/core/db/known-bad-bindings';
import * as boardAuthorityDb from '@archon/core/db/board-authority';
import * as executionClaimsDb from '@archon/core/db/execution-claims';
import * as mergeStewardDb from '@archon/core/db/merge-steward';
import * as overseerBriefingDb from '@archon/core/db/overseer-briefing';
import * as m31TargetV2Db from '@archon/core/db/m31-target-v2';
import * as m31Substrate from '@archon/overseer/m31-substrate';
import type { M31LiveStateReader } from '@archon/overseer/m31-substrate';
import { registerM31TargetV2Routes } from './m31-target-v2.routes';
import {
  deriveBoardMotionNotificationKey,
  recordBoardPetitionDelivery,
  validateBoardPetitionPointer,
  validateBoardMotionPointer,
} from '@archon/core/utils/board-motion-pointer';
import { assessDispatchMessageBody } from '@archon/core/utils/dispatch-content-guard';
import { authenticateDispatchWorkerCredential } from '../auth/dispatch-worker-credential';
import {
  DispatchNonSystemCapability,
  DispatchPrincipalAuthError,
  type DispatchSenderAuthMode,
} from '../auth/dispatch-principal';
import { createLogger as createDispatchRouteLogger } from '@archon/paths';

const dispatchSenderAuthLog = createDispatchRouteLogger('dispatch/sender-auth');
import { getOverseerRuntimeStatus } from '../overseer-runtime';
import { listOverseerCapabilityStates } from '@archon/core/db/overseer-capabilities';
import {
  countRunsPendingOverseerJudgment,
  getOverseerLastActionAt,
  getOverseerLastVerdictAt,
} from '@archon/core/db/overseer';
import { errorSchema } from './schemas/common.schemas';
import { updateCheckResponseSchema } from './schemas/system.schemas';
import {
  workflowListResponseSchema,
  workflowErrorsResponseSchema,
  validateWorkflowBodySchema,
  validateWorkflowResponseSchema,
  getWorkflowResponseSchema,
  saveWorkflowBodySchema,
  deleteWorkflowResponseSchema,
  commandListResponseSchema,
  workflowRunListResponseSchema,
  workflowRunDetailSchema,
  nodeEventsQuerySchema,
  nodeEventsResponseSchema,
  workflowRunByWorkerResponseSchema,
  cancelWorkflowRunBodySchema,
  cancelWorkflowRunResponseSchema,
  cancelStaleRunsResponseSchema,
  pauseWorkflowRunBodySchema,
  pauseWorkflowRunResponseSchema,
  workflowRunActionResponseSchema,
  dashboardRunsResponseSchema,
  runWorkflowBodySchema,
  dashboardRunsQuerySchema,
  workflowRunsQuerySchema,
  approveWorkflowRunBodySchema,
  rejectWorkflowRunBodySchema,
  archiveWorkflowRunBodySchema,
  unarchiveWorkflowRunBodySchema,
  bulkArchiveBodySchema,
  bulkArchiveResponseSchema,
  bulkDeleteFailedResponseSchema,
} from './schemas/workflow.schemas';
import {
  conversationListResponseSchema,
  listConversationsQuerySchema,
  conversationIdParamsSchema,
  conversationSchema,
  createConversationBodySchema,
  createConversationResponseSchema,
  updateConversationBodySchema,
  successResponseSchema,
  messageListResponseSchema,
  listMessagesQuerySchema,
  dispatchResponseSchema,
} from './schemas/conversation.schemas';
import {
  codebaseListResponseSchema,
  codebaseSchema,
  codebaseIdParamsSchema,
  addCodebaseBodySchema,
  deleteCodebaseResponseSchema,
  codebaseEnvVarsResponseSchema,
  setEnvVarBodySchema,
  codebaseEnvVarParamsSchema,
  envVarMutationResponseSchema,
} from './schemas/codebase.schemas';
import {
  updateAssistantConfigBodySchema,
  updateAssistantConfigResponseSchema,
  configResponseSchema,
  codebaseEnvironmentsResponseSchema,
} from './schemas/config.schemas';
import { providerListResponseSchema } from './schemas/provider.schemas';
import { canarySnapshotQuerySchema, canarySnapshotResponseSchema } from './schemas/canary.schemas';
import {
  rejectFrontierBodySchema,
  cascadeFrontierApprovalResponseSchema,
} from './schemas/cascade.schemas';
import {
  drainBodySchema,
  drainResponseSchema,
  throttleBodySchema,
  throttleResponseSchema,
} from './schemas/admin.schemas';
import {
  claimDispatchMessageBodySchema,
  createDispatchMessageBodySchema,
  supersedeDispatchMessageBodySchema,
  dispatchMailboxPrincipalBodySchema,
  dispatchMessageIdParamsSchema,
  dispatchMessageListResponseSchema,
  dispatchMessageSchema,
  dispatchSenderBodySchema,
  dispatchWorkerSchema,
  dispatchStatusQuerySchema,
  dispatchStatusResponseSchema,
  executionHandoffBodySchema,
  heartbeatDispatchWorkerBodySchema,
  listDispatchMessagesQuerySchema,
  postDispatchResultBodySchema,
  renewDispatchLeaseBodySchema,
  registerDispatchWorkerBodySchema,
} from './schemas/dispatch.schemas';
import {
  boardRecipientResponseSchema,
  xoLeaseAcquireBodySchema,
  xoLeaseReleaseBodySchema,
  xoLeaseRenewBodySchema,
  xoLeaseSchema,
} from './schemas/board-authority.schemas';
import {
  acquireExecutionClaimBodySchema,
  acquireExecutionClaimResponseSchema,
  completeExecutionClaimBodySchema,
  completeExecutionClaimResponseSchema,
  executionClaimIdParamsSchema,
  executionFenceBodySchema,
  getExecutionClaimQuerySchema,
  getExecutionClaimResponseSchema,
  preEffectResponseSchema,
  reconcileExecutionClaimBodySchema,
  reconcileExecutionClaimResponseSchema,
  reconciliationRequiredBodySchema,
  reconciliationRequiredResponseSchema,
  releaseExecutionClaimResponseSchema,
  renewExecutionClaimBodySchema,
  renewExecutionClaimResponseSchema,
} from './schemas/execution-claims.schemas';
import {
  registerM31SnapshotBodySchema,
  m31SnapshotResponseSchema,
  m31SnapshotIdParamsSchema,
  appendM31DiscrepancyBodySchema,
  m31DiscrepancyResponseSchema,
  createM31ProposalBodySchema,
  m31ProposalResponseSchema,
  m31ProposalIdParamsSchema,
  compareAndConsumeM31BodySchema,
  m31PermitResponseSchema,
} from './schemas/merge-steward.schemas';
import {
  operatorCardListQuerySchema,
  operatorCardListResponseSchema,
  operatorCardParamsSchema,
  operatorCardResponseSchema,
} from './schemas/overseer-briefing.schemas';
import {
  providerAttemptsQuerySchema,
  providerAttemptsResponseSchema,
} from './schemas/provider-attempts.schemas';
import { getProviderInfoList, isRegisteredProvider } from '@archon/providers';
import { claudeProviderThrottle } from '@archon/providers/claude/throttle';
import { buildProductionCanarySnapshot } from '../services/canary-snapshot';

// Read app version: use build-time constant in binary, package.json in dev
let appVersion = 'unknown';
if (BUNDLED_IS_BINARY) {
  appVersion = BUNDLED_VERSION;
} else {
  try {
    const pkgContent = readFileSync(join(import.meta.dir, '../../../../package.json'), 'utf-8');
    const pkg = JSON.parse(pkgContent) as { version?: string };
    appVersion = pkg.version ?? 'unknown';
  } catch (err) {
    getLog().debug(
      { err, path: join(import.meta.dir, '../../../../package.json') },
      'api.version_read_failed'
    );
  }
}

type WorkflowSource = 'project' | 'bundled' | 'global';

// =========================================================================
// OpenAPI route configs (module-scope -- pure config, no runtime dependencies)
// =========================================================================

/** Helper to build a JSON error response entry for createRoute configs. */
function jsonError(description: string): {
  content: { 'application/json': { schema: typeof errorSchema } };
  description: string;
} {
  return { content: { 'application/json': { schema: errorSchema } }, description };
}

const cwdQuerySchema = z.object({ cwd: z.string().optional() });

const getWorkflowsRoute = createRoute({
  method: 'get',
  path: '/api/workflows',
  tags: ['Workflows'],
  summary: 'List available workflows',
  request: { query: cwdQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowListResponseSchema } },
      description: 'OK',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const getWorkflowErrorsRoute = createRoute({
  method: 'get',
  path: '/api/workflows/errors',
  tags: ['Workflows'],
  summary: 'List workflow loader validation errors',
  request: { query: cwdQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowErrorsResponseSchema } },
      description: 'Workflow loader errors',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const validateWorkflowRoute = createRoute({
  method: 'post',
  path: '/api/workflows/validate',
  tags: ['Workflows'],
  summary: 'Validate a workflow definition without saving',
  request: {
    body: {
      content: { 'application/json': { schema: validateWorkflowBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: validateWorkflowResponseSchema } },
      description: 'Validation result',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const getWorkflowRoute = createRoute({
  method: 'get',
  path: '/api/workflows/{name}',
  tags: ['Workflows'],
  summary: 'Fetch a single workflow definition',
  request: {
    params: z.object({ name: z.string() }),
    query: cwdQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: getWorkflowResponseSchema } },
      description: 'Workflow definition',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const saveWorkflowRoute = createRoute({
  method: 'put',
  path: '/api/workflows/{name}',
  tags: ['Workflows'],
  summary: 'Save (create or update) a workflow',
  request: {
    params: z.object({ name: z.string() }),
    query: cwdQuerySchema,
    body: { content: { 'application/json': { schema: saveWorkflowBodySchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: getWorkflowResponseSchema } },
      description: 'Saved workflow',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const deleteWorkflowRoute = createRoute({
  method: 'delete',
  path: '/api/workflows/{name}',
  tags: ['Workflows'],
  summary: 'Delete a user-defined workflow',
  request: {
    params: z.object({ name: z.string() }),
    query: cwdQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: deleteWorkflowResponseSchema } },
      description: 'Deleted',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const getCommandsRoute = createRoute({
  method: 'get',
  path: '/api/commands',
  tags: ['Commands'],
  summary: 'List available command names for the workflow node palette',
  request: { query: cwdQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: commandListResponseSchema } },
      description: 'OK',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

// =========================================================================
// Conversation route configs
// =========================================================================

const getConversationsRoute = createRoute({
  method: 'get',
  path: '/api/conversations',
  tags: ['Conversations'],
  summary: 'List conversations',
  request: { query: listConversationsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: conversationListResponseSchema } },
      description: 'OK',
    },
    500: jsonError('Server error'),
  },
});

const getConversationRoute = createRoute({
  method: 'get',
  path: '/api/conversations/{id}',
  tags: ['Conversations'],
  summary: 'Get a conversation by platform conversation ID',
  request: { params: conversationIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: conversationSchema } },
      description: 'Conversation',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const createConversationRoute = createRoute({
  method: 'post',
  path: '/api/conversations',
  tags: ['Conversations'],
  summary: 'Create a new conversation',
  request: {
    body: {
      content: { 'application/json': { schema: createConversationBodySchema } },
      required: false,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: createConversationResponseSchema } },
      description: 'Created conversation',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
    503: jsonError('Cauldron draining'),
  },
});

const updateConversationRoute = createRoute({
  method: 'patch',
  path: '/api/conversations/{id}',
  tags: ['Conversations'],
  summary: 'Update a conversation (title)',
  request: {
    params: conversationIdParamsSchema,
    body: {
      content: { 'application/json': { schema: updateConversationBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: successResponseSchema } },
      description: 'Updated',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const deleteConversationRoute = createRoute({
  method: 'delete',
  path: '/api/conversations/{id}',
  tags: ['Conversations'],
  summary: 'Soft-delete a conversation',
  request: { params: conversationIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: successResponseSchema } },
      description: 'Deleted',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const listMessagesRoute = createRoute({
  method: 'get',
  path: '/api/conversations/{id}/messages',
  tags: ['Conversations'],
  summary: 'List message history for a conversation',
  request: {
    params: conversationIdParamsSchema,
    query: listMessagesQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: messageListResponseSchema } },
      description: 'Message list',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

// Body validation is handled manually in the handler (multipart vs JSON branching).
// Declaring both content types in the OpenAPI route causes @hono/zod-openapi to
// validate JSON bodies against the multipart schema. We keep `request.body` empty
// and document the schemas via the OpenAPI spec comments instead.
const sendMessageRoute = createRoute({
  method: 'post',
  path: '/api/conversations/{id}/message',
  tags: ['Conversations'],
  summary: 'Send a message (JSON or multipart with file uploads)',
  description:
    'Accepts `application/json` with `{ message: string }` or `multipart/form-data` ' +
    'with a `message` field and optional file attachments (max 5 files, 10 MB each).',
  request: {
    params: conversationIdParamsSchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: dispatchResponseSchema } },
      description: 'Accepted',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
    503: jsonError('Cauldron draining'),
  },
});

// =========================================================================
// Blue Devil Dispatch route configs
// =========================================================================

const createDispatchMessageRoute = createRoute({
  method: 'post',
  path: '/api/dispatch/messages',
  tags: ['Dispatch'],
  summary: 'Create an agent dispatch message',
  request: {
    body: {
      content: { 'application/json': { schema: createDispatchMessageBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: dispatchMessageSchema } },
      description: 'Dispatch message',
    },
    400: jsonError('Bad request'),
    401: jsonError('Dispatch or board principal rejected'),
    403: jsonError('Dispatch or board principal forbidden'),
    500: jsonError('Server error'),
  },
});

const listDispatchMessagesRoute = createRoute({
  method: 'get',
  path: '/api/dispatch/messages',
  tags: ['Dispatch'],
  summary: 'List agent dispatch messages',
  request: { query: listDispatchMessagesQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: dispatchMessageListResponseSchema } },
      description: 'Dispatch messages',
    },
    500: jsonError('Server error'),
  },
});

const claimDispatchMessageRoute = createRoute({
  method: 'post',
  path: '/api/dispatch/messages/{id}/claim',
  tags: ['Dispatch'],
  summary: 'Claim an agent dispatch message with a fenced lease',
  request: {
    params: dispatchMessageIdParamsSchema,
    body: {
      content: { 'application/json': { schema: claimDispatchMessageBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: dispatchMessageSchema } },
      description: 'Claimed dispatch message',
    },
    404: jsonError('Not claimable'),
    500: jsonError('Server error'),
  },
});

const postDispatchResultRoute = createRoute({
  method: 'post',
  path: '/api/dispatch/messages/{id}/result',
  tags: ['Dispatch'],
  summary: 'Complete an agent dispatch message',
  request: {
    params: dispatchMessageIdParamsSchema,
    body: {
      content: { 'application/json': { schema: postDispatchResultBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: dispatchMessageSchema } },
      description: 'Completed dispatch message',
    },
    409: jsonError('Stale fencing token or cancelled message'),
    500: jsonError('Server error'),
  },
});

const acknowledgeDispatchMessageRoute = createRoute({
  method: 'post',
  path: '/api/dispatch/messages/{id}/ack',
  tags: ['Dispatch'],
  summary: 'Acknowledge a mailbox dispatch message',
  request: {
    params: dispatchMessageIdParamsSchema,
    body: {
      content: { 'application/json': { schema: dispatchMailboxPrincipalBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: dispatchMessageSchema } },
      description: 'Acknowledged dispatch message',
    },
    404: jsonError('Dispatch message not found'),
    409: jsonError('Dispatch mailbox lifecycle conflict'),
    500: jsonError('Server error'),
  },
});

const addressDispatchMessageRoute = createRoute({
  method: 'post',
  path: '/api/dispatch/messages/{id}/address',
  tags: ['Dispatch'],
  summary: 'Address an acknowledged mailbox dispatch message',
  request: {
    params: dispatchMessageIdParamsSchema,
    body: {
      content: { 'application/json': { schema: dispatchMailboxPrincipalBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: dispatchMessageSchema } },
      description: 'Addressed dispatch message',
    },
    404: jsonError('Dispatch message not found'),
    409: jsonError('Dispatch mailbox lifecycle conflict'),
    500: jsonError('Server error'),
  },
});

const renewDispatchLeaseRoute = createRoute({
  method: 'post',
  path: '/api/dispatch/messages/{id}/renew-lease',
  tags: ['Dispatch'],
  summary: 'Extend the lease on a claimed dispatch message',
  request: {
    params: dispatchMessageIdParamsSchema,
    body: {
      content: { 'application/json': { schema: renewDispatchLeaseBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: dispatchMessageSchema } },
      description: 'Renewed dispatch message lease',
    },
    409: jsonError('Stale fencing token, not lease owner, or not claimed'),
    500: jsonError('Server error'),
  },
});

const cancelDispatchMessageRoute = createRoute({
  method: 'post',
  path: '/api/dispatch/messages/{id}/cancel',
  tags: ['Dispatch'],
  summary: 'Cancel an agent dispatch message',
  request: {
    params: dispatchMessageIdParamsSchema,
    body: {
      content: { 'application/json': { schema: dispatchSenderBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: dispatchMessageSchema } },
      description: 'Cancelled dispatch message',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const supersedeDispatchMessageRoute = createRoute({
  method: 'post',
  path: '/api/dispatch/messages/{id}/supersede',
  tags: ['Dispatch'],
  summary: 'Replace a still-queued dispatch message while preserving history',
  request: {
    params: dispatchMessageIdParamsSchema,
    body: {
      content: { 'application/json': { schema: supersedeDispatchMessageBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: dispatchMessageSchema } },
      description: 'Replacement dispatch message',
    },
    401: jsonError('Dispatch principal rejected'),
    403: jsonError('Dispatch principal forbidden'),
    404: jsonError('Not found'),
    409: jsonError('Dispatch message cannot be superseded'),
    500: jsonError('Server error'),
  },
});

const registerDispatchWorkerRoute = createRoute({
  method: 'post',
  path: '/api/dispatch/workers/register',
  tags: ['Dispatch'],
  summary: 'Register an agent dispatch worker',
  request: {
    body: {
      content: { 'application/json': { schema: registerDispatchWorkerBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: dispatchWorkerSchema } },
      description: 'Registered dispatch worker',
    },
    500: jsonError('Server error'),
  },
});

const heartbeatDispatchWorkerRoute = createRoute({
  method: 'post',
  path: '/api/dispatch/workers/heartbeat',
  tags: ['Dispatch'],
  summary: 'Heartbeat an agent dispatch worker',
  request: {
    body: {
      content: { 'application/json': { schema: heartbeatDispatchWorkerBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: dispatchWorkerSchema } },
      description: 'Heartbeat accepted',
    },
    404: jsonError('Worker not found'),
    500: jsonError('Server error'),
  },
});

const getDispatchStatusRoute = createRoute({
  method: 'get',
  path: '/api/dispatch/status',
  tags: ['Dispatch'],
  summary: 'Get truthful worker, queue, report, and handoff status',
  request: { query: dispatchStatusQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: dispatchStatusResponseSchema } },
      description: 'Dispatch status',
    },
    500: jsonError('Server error'),
  },
});

const createExecutionHandoffRoute = createRoute({
  method: 'post',
  path: '/api/dispatch/execution-handoffs',
  tags: ['Dispatch'],
  summary: 'Queue an approved local or staging execution handoff',
  request: {
    body: {
      content: { 'application/json': { schema: executionHandoffBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: dispatchMessageSchema } },
      description: 'Queued execution handoff',
    },
    400: jsonError('Bad request'),
    401: jsonError('Dispatch principal rejected'),
    403: jsonError('Dispatch principal forbidden'),
    500: jsonError('Server error'),
  },
});

// =========================================================================
// Board authority route configs
// =========================================================================

const acquireXoLeaseRoute = createRoute({
  method: 'post',
  path: '/api/board/xo-lease/acquire',
  tags: ['Board Authority'],
  summary: 'Acquire or take over the fenced XO lease',
  request: {
    body: {
      content: { 'application/json': { schema: xoLeaseAcquireBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: xoLeaseSchema } },
      description: 'Current XO lease',
    },
    401: jsonError('Board principal rejected'),
    409: jsonError('Lease conflict'),
    500: jsonError('Server error'),
  },
});

const renewXoLeaseRoute = createRoute({
  method: 'post',
  path: '/api/board/xo-lease/renew',
  tags: ['Board Authority'],
  summary: 'Renew the current fenced XO lease',
  request: {
    body: {
      content: { 'application/json': { schema: xoLeaseRenewBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: xoLeaseSchema } },
      description: 'Renewed XO lease',
    },
    401: jsonError('Board principal rejected'),
    409: jsonError('Stale lease token'),
    500: jsonError('Server error'),
  },
});

const releaseXoLeaseRoute = createRoute({
  method: 'post',
  path: '/api/board/xo-lease/release',
  tags: ['Board Authority'],
  summary: 'Release the current fenced XO lease',
  request: {
    body: {
      content: { 'application/json': { schema: xoLeaseReleaseBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: xoLeaseSchema } },
      description: 'Released XO lease',
    },
    401: jsonError('Board principal rejected'),
    409: jsonError('Stale lease token'),
    500: jsonError('Server error'),
  },
});

const currentXoLeaseRoute = createRoute({
  method: 'get',
  path: '/api/board/xo-lease/current',
  tags: ['Board Authority'],
  summary: 'Read the current unexpired XO lease',
  responses: {
    200: {
      content: { 'application/json': { schema: xoLeaseSchema.nullable() } },
      description: 'Current XO lease or null',
    },
    500: jsonError('Server error'),
  },
});

const boardRecipientRoute = createRoute({
  method: 'get',
  path: '/api/board/recipient',
  tags: ['Board Authority'],
  summary: 'Resolve the board alias to the current XO holder',
  responses: {
    200: {
      content: { 'application/json': { schema: boardRecipientResponseSchema } },
      description: 'Board recipient resolution',
    },
    500: jsonError('Server error'),
  },
});

// =========================================================================
// Execution claim route configs (M-27B)
// =========================================================================

const acquireExecutionClaimRoute = createRoute({
  method: 'post',
  path: '/api/board/execution-claims/acquire',
  tags: ['Execution Claims'],
  summary: 'Acquire, take over, or reactivate a fenced execution claim',
  request: {
    body: {
      content: { 'application/json': { schema: acquireExecutionClaimBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: acquireExecutionClaimResponseSchema } },
      description: 'Existing claim for the same action identity',
    },
    201: {
      content: { 'application/json': { schema: acquireExecutionClaimResponseSchema } },
      description: 'New, taken-over, or reactivated claim',
    },
    400: jsonError('Validation failed'),
    401: jsonError('Board principal or holder rejected'),
    409: jsonError('Claim conflict or reconciliation required'),
    500: jsonError('Server error'),
  },
});

const renewExecutionClaimRoute = createRoute({
  method: 'post',
  path: '/api/board/execution-claims/{claim_id}/renew',
  tags: ['Execution Claims'],
  summary: 'Renew a current execution claim',
  request: {
    params: executionClaimIdParamsSchema,
    body: {
      content: { 'application/json': { schema: renewExecutionClaimBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: renewExecutionClaimResponseSchema } },
      description: 'Renewed claim',
    },
    401: jsonError('Board principal or holder rejected'),
    404: jsonError('Claim not found'),
    409: jsonError('Stale fence'),
    500: jsonError('Server error'),
  },
});

const preEffectExecutionClaimRoute = createRoute({
  method: 'post',
  path: '/api/board/execution-claims/{claim_id}/pre-effect',
  tags: ['Execution Claims'],
  summary: 'Atomically arm a reconciliation-required effect attempt',
  request: {
    params: executionClaimIdParamsSchema,
    body: {
      content: { 'application/json': { schema: executionFenceBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: preEffectResponseSchema } },
      description: 'Pre-effect permission granted after arm commit',
    },
    401: jsonError('Board principal or holder rejected'),
    404: jsonError('Claim not found'),
    409: jsonError('Stale fence or reconciliation required'),
    500: jsonError('Server error'),
  },
});

const reconciliationRequiredExecutionClaimRoute = createRoute({
  method: 'post',
  path: '/api/board/execution-claims/{claim_id}/reconciliation-required',
  tags: ['Execution Claims'],
  summary: 'Record an uncertain external outcome and block the claim',
  request: {
    params: executionClaimIdParamsSchema,
    body: {
      content: { 'application/json': { schema: reconciliationRequiredBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: reconciliationRequiredResponseSchema } },
      description: 'Reconciliation required recorded',
    },
    401: jsonError('Board principal or holder rejected'),
    404: jsonError('Claim not found'),
    409: jsonError('Effect attempt mismatch or stale fence'),
    500: jsonError('Server error'),
  },
});

const reconcileExecutionClaimRoute = createRoute({
  method: 'post',
  path: '/api/board/execution-claims/{claim_id}/reconcile',
  tags: ['Execution Claims'],
  summary: 'Resolve a reconciliation-required claim with live-state evidence',
  request: {
    params: executionClaimIdParamsSchema,
    body: {
      content: { 'application/json': { schema: reconcileExecutionClaimBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: reconcileExecutionClaimResponseSchema } },
      description: 'Reconciliation resolved',
    },
    400: jsonError('Validation failed'),
    401: jsonError('Board principal or holder rejected'),
    404: jsonError('Claim not found'),
    409: jsonError('Effect attempt mismatch or stale fence'),
    500: jsonError('Server error'),
  },
});

const releaseExecutionClaimRoute = createRoute({
  method: 'post',
  path: '/api/board/execution-claims/{claim_id}/release',
  tags: ['Execution Claims'],
  summary: 'Release a current execution claim without deleting history',
  request: {
    params: executionClaimIdParamsSchema,
    body: {
      content: { 'application/json': { schema: executionFenceBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: releaseExecutionClaimResponseSchema } },
      description: 'Released claim',
    },
    401: jsonError('Board principal or holder rejected'),
    404: jsonError('Claim not found'),
    409: jsonError('Stale fence or reconciliation required'),
    500: jsonError('Server error'),
  },
});

const completeExecutionClaimRoute = createRoute({
  method: 'post',
  path: '/api/board/execution-claims/{claim_id}/complete',
  tags: ['Execution Claims'],
  summary: 'Complete an armed execution claim with structured evidence',
  request: {
    params: executionClaimIdParamsSchema,
    body: {
      content: { 'application/json': { schema: completeExecutionClaimBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: completeExecutionClaimResponseSchema } },
      description: 'Completed claim',
    },
    400: jsonError('Validation failed'),
    401: jsonError('Board principal or holder rejected'),
    404: jsonError('Claim not found'),
    409: jsonError('Effect attempt mismatch or stale fence'),
    500: jsonError('Server error'),
  },
});

const getExecutionClaimRoute = createRoute({
  method: 'get',
  path: '/api/board/execution-claims',
  tags: ['Execution Claims'],
  summary: 'Read an execution claim by exact action identity',
  request: { query: getExecutionClaimQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: getExecutionClaimResponseSchema } },
      description: 'Execution claim',
    },
    404: jsonError('Claim not found'),
    500: jsonError('Server error'),
  },
});

// =========================================================================
// M-31 Overseer merge-steward substrate route configs (M-42 Slice 2)
// =========================================================================

const registerM31SnapshotRoute = createRoute({
  method: 'post',
  path: '/api/overseer/m31/snapshots',
  tags: ['Overseer M31'],
  summary: 'Register an immutable M-31 live-state snapshot with sorted membership',
  request: {
    body: {
      content: { 'application/json': { schema: registerM31SnapshotBodySchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: m31SnapshotResponseSchema } },
      description: 'Registered snapshot',
    },
    400: jsonError('Validation failed'),
    401: jsonError('Board principal rejected'),
    500: jsonError('Server error'),
  },
});

const getM31SnapshotRoute = createRoute({
  method: 'get',
  path: '/api/overseer/m31/snapshots/{snapshot_id}',
  tags: ['Overseer M31'],
  summary: 'Read an immutable M-31 snapshot and its sorted members',
  request: { params: m31SnapshotIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: m31SnapshotResponseSchema } },
      description: 'Snapshot',
    },
    401: jsonError('Board principal rejected'),
    404: jsonError('Snapshot not found'),
    500: jsonError('Server error'),
  },
});

const appendM31DiscrepancyRoute = createRoute({
  method: 'post',
  path: '/api/overseer/m31/snapshots/{snapshot_id}/discrepancies',
  tags: ['Overseer M31'],
  summary: 'Append an M-31 discrepancy without mutating prior evidence',
  request: {
    params: m31SnapshotIdParamsSchema,
    body: {
      content: { 'application/json': { schema: appendM31DiscrepancyBodySchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: m31DiscrepancyResponseSchema } },
      description: 'Appended discrepancy',
    },
    400: jsonError('Validation failed'),
    401: jsonError('Board principal rejected'),
    500: jsonError('Server error'),
  },
});

const createM31ProposalRoute = createRoute({
  method: 'post',
  path: '/api/overseer/m31/proposals',
  tags: ['Overseer M31'],
  summary: 'Create an immutable, expiring, exact-state M-31 action proposal',
  request: {
    body: {
      content: { 'application/json': { schema: createM31ProposalBodySchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: m31ProposalResponseSchema } },
      description: 'Created proposal',
    },
    400: jsonError('Validation failed'),
    401: jsonError('Board principal rejected'),
    409: jsonError('Evidence, chain, or discrepancy failure'),
    500: jsonError('Server error'),
  },
});

const getM31ProposalRoute = createRoute({
  method: 'get',
  path: '/api/overseer/m31/proposals/{proposal_id}',
  tags: ['Overseer M31'],
  summary: 'Read an M-31 action proposal by exact identity',
  request: { params: m31ProposalIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: m31ProposalResponseSchema } },
      description: 'Proposal',
    },
    401: jsonError('Board principal rejected'),
    404: jsonError('Proposal not found'),
    500: jsonError('Server error'),
  },
});

const compareAndConsumeM31ProposalRoute = createRoute({
  method: 'post',
  path: '/api/overseer/m31/proposals/{proposal_id}/compare-and-consume',
  tags: ['Overseer M31'],
  summary: 'Final exact live-state comparison and single-use permit issuance',
  request: {
    params: m31ProposalIdParamsSchema,
    body: {
      content: { 'application/json': { schema: compareAndConsumeM31BodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: m31PermitResponseSchema } },
      description: 'Permit issued',
    },
    400: jsonError('Validation failed'),
    401: jsonError('Board principal rejected'),
    403: jsonError('Capability gate denied'),
    404: jsonError('Proposal not found'),
    409: jsonError('Typed comparison or single-use failure'),
    500: jsonError('Server error'),
  },
});

const listOperatorCardsRoute = createRoute({
  method: 'get',
  path: '/api/overseer/operator-cards',
  tags: ['Overseer Briefing'],
  summary: 'List immutable operator cards and derived delivery state',
  request: { query: operatorCardListQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: operatorCardListResponseSchema } },
      description: 'Operator-card feed',
    },
    401: jsonError('Board principal rejected'),
    500: jsonError('Server error'),
  },
});

const getOperatorCardRoute = createRoute({
  method: 'get',
  path: '/api/overseer/operator-cards/{card_id}',
  tags: ['Overseer Briefing'],
  summary: 'Read one immutable operator card and append-only receipts',
  request: { params: operatorCardParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: operatorCardResponseSchema } },
      description: 'Operator card',
    },
    401: jsonError('Board principal rejected'),
    404: jsonError('Operator card not found'),
    500: jsonError('Server error'),
  },
});

// =========================================================================
// Codebase route configs
// =========================================================================

const listCodebasesRoute = createRoute({
  method: 'get',
  path: '/api/codebases',
  tags: ['Codebases'],
  summary: 'List registered codebases',
  responses: {
    200: {
      content: { 'application/json': { schema: codebaseListResponseSchema } },
      description: 'OK',
    },
    500: jsonError('Server error'),
  },
});

const getCodebaseRoute = createRoute({
  method: 'get',
  path: '/api/codebases/{id}',
  tags: ['Codebases'],
  summary: 'Get a codebase by ID',
  request: { params: codebaseIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: codebaseSchema } },
      description: 'Codebase',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const addCodebaseRoute = createRoute({
  method: 'post',
  path: '/api/codebases',
  tags: ['Codebases'],
  summary: 'Register a codebase (clone from URL or register local path)',
  request: {
    body: {
      content: { 'application/json': { schema: addCodebaseBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: codebaseSchema } },
      description: 'Codebase already existed',
    },
    201: {
      content: { 'application/json': { schema: codebaseSchema } },
      description: 'Codebase created',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const deleteCodebaseRoute = createRoute({
  method: 'delete',
  path: '/api/codebases/{id}',
  tags: ['Codebases'],
  summary: 'Delete a codebase and clean up associated resources',
  request: { params: codebaseIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: deleteCodebaseResponseSchema } },
      description: 'Deleted',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

// =========================================================================
// Codebase env var route configs
// =========================================================================

const listEnvVarsRoute = createRoute({
  method: 'get',
  path: '/api/codebases/{id}/env',
  tags: ['Codebases'],
  summary: 'List env vars for a codebase',
  request: { params: codebaseIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: codebaseEnvVarsResponseSchema } },
      description: 'Env vars for codebase',
    },
    404: jsonError('Codebase not found'),
  },
});

const setEnvVarRoute = createRoute({
  method: 'put',
  path: '/api/codebases/{id}/env',
  tags: ['Codebases'],
  summary: 'Set (upsert) an env var for a codebase',
  request: {
    params: codebaseIdParamsSchema,
    body: { content: { 'application/json': { schema: setEnvVarBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: envVarMutationResponseSchema } },
      description: 'Env var set',
    },
    404: jsonError('Codebase not found'),
  },
});

const deleteEnvVarRoute = createRoute({
  method: 'delete',
  path: '/api/codebases/{id}/env/{key}',
  tags: ['Codebases'],
  summary: 'Delete an env var from a codebase',
  request: { params: codebaseEnvVarParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: envVarMutationResponseSchema } },
      description: 'Env var deleted',
    },
    404: jsonError('Codebase not found'),
  },
});

// =========================================================================
// Workflow run route configs
// =========================================================================

const runWorkflowRoute = createRoute({
  method: 'post',
  path: '/api/workflows/{name}/run',
  tags: ['Workflows'],
  summary: 'Run a workflow via the orchestrator',
  request: {
    params: z.object({ name: z.string() }),
    body: {
      content: { 'application/json': { schema: runWorkflowBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: dispatchResponseSchema } },
      description: 'Accepted',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
    503: jsonError('Cauldron draining'),
  },
});

const getDashboardRunsRoute = createRoute({
  method: 'get',
  path: '/api/dashboard/runs',
  tags: ['Workflows'],
  summary: 'List enriched workflow runs for the Command Center dashboard',
  request: { query: dashboardRunsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: dashboardRunsResponseSchema } },
      description: 'OK',
    },
    500: jsonError('Server error'),
  },
});

const getWorkflowRunByWorkerRoute = createRoute({
  method: 'get',
  path: '/api/workflows/runs/by-worker/{platformId}',
  tags: ['Workflows'],
  summary: 'Look up a workflow run by its worker conversation platform ID',
  request: { params: z.object({ platformId: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunByWorkerResponseSchema } },
      description: 'Workflow run',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const listWorkflowRunsRoute = createRoute({
  method: 'get',
  path: '/api/workflows/runs',
  tags: ['Workflows'],
  summary: 'List workflow runs',
  request: { query: workflowRunsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunListResponseSchema } },
      description: 'OK',
    },
    500: jsonError('Server error'),
  },
});

/**
 * Compute the derived Max-20x quota-window summary returned alongside the
 * paginated runs list.
 *
 * `windowTokens` is a FULL-WINDOW aggregation (NOT limited to the current
 * page of runs). It is sourced from `workflowDb.sumWorkflowTokensInWindow`,
 * which sums `metadata.total_tokens` across every non-archived run whose
 * activity timestamp (`COALESCE(last_activity_at, started_at)`) falls inside
 * the rolling window. This prevents under-reporting when in-window runs spill
 * past the runs-list pagination LIMIT (default 50, max 200).
 *
 * `MAX20X_WINDOW_TOKENS` and `MAX20X_WINDOW_HOURS` are read from process.env at
 * call time (NOT at module load) so test overrides via
 * `process.env['MAX20X_...'] = '...'` take effect without `mock.module()` or
 * a module reload. Default window length: 5 hours (a rough proxy for the
 * Max-20x rolling rate-limit window, NOT a billed quota). `windowBudget` is
 * `null` when `MAX20X_WINDOW_TOKENS` is unset -- the runs API still surfaces
 * `windowTokens` in that case (raw-first fallback). Any UI rendering MUST
 * label these values as estimated.
 */
function getQuotaWindowParams(): {
  windowBudget: number | null;
  windowStartMs: number;
  windowResetAt: string;
} {
  const rawBudget = process.env.MAX20X_WINDOW_TOKENS;
  const windowBudget =
    rawBudget !== undefined && rawBudget !== '' && !Number.isNaN(Number(rawBudget))
      ? Number(rawBudget)
      : null;
  const rawHours = process.env.MAX20X_WINDOW_HOURS;
  const windowHours =
    rawHours !== undefined && rawHours !== '' && !Number.isNaN(Number(rawHours))
      ? Number(rawHours)
      : 5;
  const now = Date.now();
  const windowMs = windowHours * 60 * 60 * 1000;
  // Rolling window: the reset point is when content entering the window right
  // now would age out (now + windowHours). This is an estimate; the real
  // Max-20x boundary is not exposed to us.
  return {
    windowBudget,
    windowStartMs: now - windowMs,
    windowResetAt: new Date(now + windowMs).toISOString(),
  };
}

async function computeQuotaWindow(codebaseId?: string): Promise<{
  windowTokens: number;
  windowBudget: number | null;
  windowResetAt: string;
}> {
  const { windowBudget, windowStartMs, windowResetAt } = getQuotaWindowParams();
  let windowTokens = 0;
  try {
    windowTokens = await workflowDb.sumWorkflowTokensInWindow({
      sinceMs: windowStartMs,
      codebaseId,
    });
  } catch (err) {
    // Raw-first fallback: a failure to aggregate must NOT take down the runs
    // list (the quota summary is auxiliary). Surface 0 + log; the page-of-runs
    // response itself is still useful without the quota line.
    getLog().error({ err }, 'quota_window_sum_failed');
    windowTokens = 0;
  }
  return { windowTokens, windowBudget, windowResetAt };
}

const cancelWorkflowRunRoute = createRoute({
  method: 'post',
  path: '/api/workflows/runs/{runId}/cancel',
  tags: ['Workflows'],
  summary: 'Cancel a workflow run',
  request: {
    params: z.object({ runId: z.string() }),
    body: {
      content: { 'application/json': { schema: cancelWorkflowRunBodySchema } },
      required: false,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: cancelWorkflowRunResponseSchema } },
      description: 'Cancelled',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    409: jsonError('Already cancelled'),
    422: jsonError('Cannot cancel a terminal run'),
    500: jsonError('Server error'),
  },
});

const pauseWorkflowRunRoute = createRoute({
  method: 'post',
  path: '/api/workflows/runs/{runId}/pause',
  tags: ['Workflows'],
  summary: 'Pause a running workflow run (operator-triggered)',
  request: {
    params: z.object({ runId: z.string() }),
    body: {
      content: { 'application/json': { schema: pauseWorkflowRunBodySchema } },
      required: false,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: pauseWorkflowRunResponseSchema } },
      description: 'Paused',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    409: jsonError('Already paused'),
    422: jsonError('Cannot pause a terminal run'),
    500: jsonError('Server error'),
  },
});

// Smart Cauldron frontier-approval gate (WO-HARNESS-FRONTIER-CLIMB-APPROVAL-GATE-01).
// An automatic climb into a premium tier pauses instead of firing; these two
// endpoints let an operator resolve the pause. Auth is the global /api/*
// operator-token middleware.
const approveFrontierRoute = createRoute({
  method: 'post',
  path: '/api/cascades/{cascadeId}/approve-frontier',
  tags: ['Cascades'],
  summary: 'Approve a paused premium-tier climb (resume + fire exactly once)',
  request: {
    params: z.object({ cascadeId: z.string() }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: cascadeFrontierApprovalResponseSchema } },
      description: 'Approved (resumed) or idempotent no-op if already resolved',
    },
    404: jsonError('Cascade not found'),
    422: jsonError('Cascade is not awaiting frontier approval'),
    500: jsonError('Server error'),
  },
});

const rejectFrontierRoute = createRoute({
  method: 'post',
  path: '/api/cascades/{cascadeId}/reject-frontier',
  tags: ['Cascades'],
  summary: 'Reject a paused premium-tier climb (terminate as needs-human, no fire)',
  request: {
    params: z.object({ cascadeId: z.string() }),
    body: {
      content: { 'application/json': { schema: rejectFrontierBodySchema } },
      required: false,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: cascadeFrontierApprovalResponseSchema } },
      description: 'Rejected or idempotent no-op if already resolved',
    },
    404: jsonError('Cascade not found'),
    422: jsonError('Cascade is not awaiting frontier approval'),
    500: jsonError('Server error'),
  },
});

const adminThrottleRoute = createRoute({
  method: 'post',
  path: '/api/admin/throttle',
  tags: ['Admin'],
  summary: 'Engage or release the global Claude provider throttle gate',
  request: {
    body: { content: { 'application/json': { schema: throttleBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: throttleResponseSchema } },
      description: 'Throttle state updated',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const getAdminThrottleRoute = createRoute({
  method: 'get',
  path: '/api/admin/throttle',
  tags: ['Admin'],
  summary: 'Read the current global Claude provider throttle state',
  responses: {
    200: {
      content: { 'application/json': { schema: throttleResponseSchema } },
      description: 'Current throttle state',
    },
    500: jsonError('Server error'),
  },
});

const adminDrainRoute = createRoute({
  method: 'post',
  path: '/api/admin/drain',
  tags: ['Admin'],
  summary: 'Enable or disable durable Cauldron drain mode',
  request: {
    body: { content: { 'application/json': { schema: drainBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: drainResponseSchema } },
      description: 'Drain state updated',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const getAdminDrainRoute = createRoute({
  method: 'get',
  path: '/api/admin/drain',
  tags: ['Admin'],
  summary: 'Read durable Cauldron drain mode and active work',
  responses: {
    200: {
      content: { 'application/json': { schema: drainResponseSchema } },
      description: 'Current drain state',
    },
    500: jsonError('Server error'),
  },
});

const getCanarySnapshotRoute = createRoute({
  method: 'get',
  path: '/api/admin/canary/snapshot',
  tags: ['Admin'],
  summary: 'Read immutable Smart Cauldron canary planning facts',
  request: { query: canarySnapshotQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: canarySnapshotResponseSchema } },
      description: 'Read-only canary snapshot',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const cancelStaleWorkflowRunsRoute = createRoute({
  method: 'post',
  path: '/api/workflows/runs/cancel-stale',
  tags: ['Workflows'],
  summary: 'Cancel all stale running workflow runs (default: idle > 30 minutes)',
  responses: {
    200: {
      content: { 'application/json': { schema: cancelStaleRunsResponseSchema } },
      description: 'OK',
    },
    500: jsonError('Server error'),
  },
});

const resumeWorkflowRunRoute = createRoute({
  method: 'post',
  path: '/api/workflows/runs/{runId}/resume',
  tags: ['Workflows'],
  summary: 'Resume a failed workflow run (re-run auto-resumes from completed nodes)',
  request: { params: z.object({ runId: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunActionResponseSchema } },
      description: 'Resumed',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const abandonWorkflowRunRoute = createRoute({
  method: 'post',
  path: '/api/workflows/runs/{runId}/abandon',
  tags: ['Workflows'],
  summary: 'Abandon a workflow run (mark as failed)',
  request: { params: z.object({ runId: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunActionResponseSchema } },
      description: 'Abandoned',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const approveWorkflowRunRoute = createRoute({
  method: 'post',
  path: '/api/workflows/runs/{runId}/approve',
  tags: ['Workflows'],
  summary: 'Approve a paused workflow run',
  request: {
    params: z.object({ runId: z.string() }),
    body: { content: { 'application/json': { schema: approveWorkflowRunBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunActionResponseSchema } },
      description: 'Approved',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const rejectWorkflowRunRoute = createRoute({
  method: 'post',
  path: '/api/workflows/runs/{runId}/reject',
  tags: ['Workflows'],
  summary: 'Reject a paused workflow run',
  request: {
    params: z.object({ runId: z.string() }),
    body: { content: { 'application/json': { schema: rejectWorkflowRunBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunActionResponseSchema } },
      description: 'Rejected',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const deleteWorkflowRunRoute = createRoute({
  method: 'delete',
  path: '/api/workflows/runs/{runId}',
  tags: ['Workflows'],
  summary: 'Delete a workflow run and its events',
  request: { params: z.object({ runId: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunActionResponseSchema } },
      description: 'Deleted',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const getWorkflowRunRoute = createRoute({
  method: 'get',
  path: '/api/workflows/runs/{runId}',
  tags: ['Workflows'],
  summary: 'Get workflow run details with events',
  request: { params: z.object({ runId: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunDetailSchema } },
      description: 'Workflow run detail',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const getNodeEventsRoute = createRoute({
  method: 'get',
  path: '/api/workflows/runs/{runId}/nodes/{nodeId}/events',
  tags: ['Workflows'],
  summary: 'Get the last N events for a single node in a workflow run',
  request: {
    params: z.object({ runId: z.string(), nodeId: z.string() }),
    query: nodeEventsQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: nodeEventsResponseSchema } },
      description: 'Recent events for the node (newest first)',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

// Archive/unarchive/bulk-archive/bulk-delete routes -- registered before {runId} routes
// to prevent literal paths from matching as runId param values.

const archiveWorkflowRunRoute = createRoute({
  method: 'post',
  path: '/api/workflows/runs/{runId}/archive',
  tags: ['Workflows'],
  summary: 'Archive a workflow run (hide from default dashboard view)',
  request: {
    params: z.object({ runId: z.string() }),
    body: { content: { 'application/json': { schema: archiveWorkflowRunBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunActionResponseSchema } },
      description: 'Archived',
    },
    400: jsonError('Bad request'),
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const unarchiveWorkflowRunRoute = createRoute({
  method: 'post',
  path: '/api/workflows/runs/{runId}/unarchive',
  tags: ['Workflows'],
  summary: 'Unarchive a workflow run (restore to default dashboard view)',
  request: {
    params: z.object({ runId: z.string() }),
    body: { content: { 'application/json': { schema: unarchiveWorkflowRunBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: workflowRunActionResponseSchema } },
      description: 'Unarchived',
    },
    404: jsonError('Not found'),
    500: jsonError('Server error'),
  },
});

const bulkArchiveWorkflowRunsRoute = createRoute({
  method: 'post',
  path: '/api/workflows/runs/bulk-archive',
  tags: ['Workflows'],
  summary: 'Bulk-archive workflow runs by status',
  request: {
    body: { content: { 'application/json': { schema: bulkArchiveBodySchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: bulkArchiveResponseSchema } },
      description: 'Bulk archived',
    },
    400: jsonError('Bad request'),
    500: jsonError('Server error'),
  },
});

const bulkDeleteFailedRunsRoute = createRoute({
  method: 'delete',
  path: '/api/workflows/runs/bulk-failed',
  tags: ['Workflows'],
  summary: 'Bulk-delete archived failed runs (permanent). Use dryRun=true to preview.',
  request: {
    query: z.object({
      dryRun: z.string().optional(),
      olderThan: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: { 'application/json': { schema: bulkDeleteFailedResponseSchema } },
      description: 'Bulk deleted (or dry run preview)',
    },
    400: jsonError('Invalid olderThan duration or timestamp'),
    500: jsonError('Server error'),
  },
});

// =========================================================================
// Config / health route configs
// =========================================================================

const getConfigRoute = createRoute({
  method: 'get',
  path: '/api/config',
  tags: ['System'],
  summary: 'Get read-only configuration (safe subset)',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: configResponseSchema,
        },
      },
      description: 'Configuration',
    },
    500: jsonError('Server error'),
  },
});

const patchAssistantConfigRoute = createRoute({
  method: 'patch',
  path: '/api/config/assistants',
  tags: ['System'],
  summary: 'Update assistant configuration',
  request: {
    body: {
      content: { 'application/json': { schema: updateAssistantConfigBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: updateAssistantConfigResponseSchema } },
      description: 'Updated configuration',
    },
    400: jsonError('Invalid request body'),
    500: jsonError('Server error'),
  },
});

const getProvidersRoute = createRoute({
  method: 'get',
  path: '/api/providers',
  tags: ['System'],
  summary: 'List registered AI providers',
  responses: {
    200: {
      content: { 'application/json': { schema: providerListResponseSchema } },
      description: 'List of registered providers',
    },
  },
});

const getCodebaseEnvironmentsRoute = createRoute({
  method: 'get',
  path: '/api/codebases/{id}/environments',
  tags: ['Codebases'],
  summary: 'List isolation environments for a codebase',
  request: { params: codebaseIdParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: codebaseEnvironmentsResponseSchema } },
      description: 'List of isolation environments',
    },
    404: jsonError('Codebase not found'),
    500: jsonError('Server error'),
  },
});

const getHealthRoute = createRoute({
  method: 'get',
  path: '/api/health',
  tags: ['System'],
  summary: 'Health check',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z
            .object({
              status: z.string(),
              adapter: z.string(),
              concurrency: z.record(z.unknown()),
              runningWorkflows: z.number(),
              version: z.string().optional(),
              is_docker: z.boolean(),
              activePlatforms: z.array(z.string()).optional(),
              overseer: z
                .object({
                  status: z.string(),
                  watcher: z.string(),
                  adapter: z.string(),
                  emergency_stop: z.boolean(),
                  capability_flags: z.record(z.boolean()),
                  circuit_states: z.record(z.string()),
                  last_action_at: z.string().nullable(),
                  last_verdict_at: z.string().nullable(),
                  blocking_reasons: z.array(z.string()),
                })
                .optional(),
            })
            .openapi('HealthResponse'),
        },
      },
      description: 'Health status',
    },
  },
});

// Per-resource metric shapes. The collector (separate WO
// WO-INFRA-HOST-METRICS-COLLECTOR-01 in bdc-xo) writes this JSON file.
// Per-field numeric values are nullable when the collector reads the
// section but cannot sample a specific value (e.g. df returned but the
// "used" column was unreadable); the whole field is null when the
// resource section is missing from the file entirely. The schema MUST
// express both states so the generated API contract matches what the
// collector can actually emit -- and the handler validates parsed JSON
// against this schema before returning it.
const diskMetricSchema = z
  .object({
    used_gb: z.number().nullable(),
    total_gb: z.number().nullable(),
    pct: z.number().nullable(),
  })
  .nullable();
const cpuMetricSchema = z
  .object({
    pct: z.number().nullable(),
  })
  .nullable();
const memMetricSchema = z
  .object({
    used_gb: z.number().nullable(),
    total_gb: z.number().nullable(),
    pct: z.number().nullable(),
  })
  .nullable();

// Body schema reused for handler-side validation of parsed collector JSON.
// Kept separate from the route response wrapper so we can `.safeParse()`
// the raw file contents and fall back to the no-data shape if the
// collector emits something outside the contract.
const hostMetricsBodySchema = z.object({
  status: z.enum(['ok', 'stale', 'no-data']),
  disk: diskMetricSchema,
  cpu: cpuMetricSchema,
  mem: memMetricSchema,
  collectedAt: z.string().nullable(),
  stale: z.boolean(),
});

const getHostMetricsRoute = createRoute({
  method: 'get',
  path: '/api/host-metrics',
  tags: ['System'],
  summary: 'Host disk/cpu/mem snapshot written by the host collector',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: hostMetricsBodySchema.openapi('HostMetricsResponse'),
        },
      },
      description: 'Host metrics snapshot, stale flag, or no-data placeholder',
    },
  },
});

const listProviderAttemptsRoute = createRoute({
  method: 'get',
  path: '/api/dashboard/provider-attempts',
  tags: ['Dashboard'],
  summary: 'Read-only feed of provider-attempt outcomes for engine reliability',
  request: { query: providerAttemptsQuerySchema },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: providerAttemptsResponseSchema.openapi('ProviderAttemptsResponse'),
        },
      },
      description: 'Raw provider-attempt rows (no server-side aggregation)',
    },
    401: jsonError('Missing or invalid operator token'),
    500: jsonError('Server error'),
  },
});

const getUpdateCheckRoute = createRoute({
  method: 'get',
  path: '/api/update-check',
  tags: ['System'],
  summary: 'Check for available updates',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: updateCheckResponseSchema,
        },
      },
      description: 'Update check result',
    },
  },
});

// Taskmaster Slice 1 operator routes (WO-HARNESS-TASKMASTER-SLICE1-01).
// Auth is covered by the global /api/* operator-token middleware.
const getTaskmasterStatusRoute = createRoute({
  method: 'get',
  path: '/api/taskmaster/status',
  tags: ['Taskmaster'],
  summary: 'Taskmaster pause state, epoch, and tick health',
  responses: {
    200: {
      content: { 'application/json': { schema: taskmasterStatusResponseSchema } },
      description: 'Taskmaster status incl. tick_health for the external dead-man checker',
    },
    401: jsonError('Missing or invalid operator token'),
    500: jsonError('Server error'),
  },
});

const getTaskmasterRegisterRoute = createRoute({
  method: 'get',
  path: '/api/taskmaster/register',
  tags: ['Taskmaster'],
  summary: 'Read the committed Taskmaster adoption register',
  request: { query: registerListQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: registerListResponseSchema } },
      description: 'Paged and filtered rows from the committed adoption snapshot',
    },
    401: jsonError('Missing or invalid operator token'),
    500: jsonError('Server error'),
  },
});

const getTaskmasterRegisterMetaRoute = createRoute({
  method: 'get',
  path: '/api/taskmaster/register/meta',
  tags: ['Taskmaster'],
  summary: 'Read Taskmaster register freshness and operator state',
  responses: {
    200: {
      content: { 'application/json': { schema: registerMetaResponseSchema } },
      description: 'Register freshness, completeness, pause state, and XO backlog',
    },
    401: jsonError('Missing or invalid operator token'),
    500: jsonError('Server error'),
  },
});

const postTaskmasterPauseRoute = createRoute({
  method: 'post',
  path: '/api/taskmaster/pause',
  tags: ['Taskmaster'],
  summary: 'Pause taskmaster effects (monitoring, P0 escalation, digest stay alive)',
  request: {
    body: {
      content: { 'application/json': { schema: taskmasterPauseBodySchema } },
      required: false,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: taskmasterControlResponseSchema } },
      description: 'Updated control state',
    },
    401: jsonError('Missing or invalid operator token'),
    500: jsonError('Server error'),
  },
});

const postTaskmasterResumeRoute = createRoute({
  method: 'post',
  path: '/api/taskmaster/resume',
  tags: ['Taskmaster'],
  summary: 'Resume taskmaster (John-authorized): epoch increments, stale proposals expire',
  request: {
    body: {
      content: { 'application/json': { schema: taskmasterResumeBodySchema } },
      required: false,
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: taskmasterControlResponseSchema } },
      description: 'Updated control state with expired-proposal count',
    },
    401: jsonError('Missing or invalid operator token'),
    500: jsonError('Server error'),
  },
});

/**
 * Register all /api/* routes on the Hono app.
 */
export function registerApiRoutes(
  app: OpenAPIHono,
  webAdapter: WebAdapter,
  lockManager: ConversationLockManager,
  activePlatforms?: readonly string[],
  canarySnapshotBuilder: typeof buildProductionCanarySnapshot = buildProductionCanarySnapshot
): void {
  function apiError(
    c: Context,
    status: 400 | 401 | 403 | 404 | 409 | 422 | 500 | 503,
    message: string,
    detail?: string
  ): Response {
    return c.json({ error: message, ...(detail ? { detail } : {}) }, status);
  }

  function isBoardPrincipalAuthError(error: unknown): boolean {
    return error instanceof Error && error.message.startsWith('board_principal_auth_');
  }

  function resolveDispatchHttpSenderContext(
    c: Context,
    requestedSender: string
  ): {
    context: dispatchDb.DispatchSenderContext;
    mode: DispatchSenderAuthMode;
  } {
    const principalId = c.req.header('x-dispatch-principal-id');
    const principalToken = c.req.header('x-dispatch-principal-token');
    const result = DispatchNonSystemCapability.fromHttpRequest({
      principal_id: principalId,
      token: principalToken,
      requested_sender: requestedSender,
    });
    if (result.warnLegacy) {
      dispatchSenderAuthLog.warn(
        {
          mode: result.mode,
          path: c.req.path,
          failureClass: 'legacy_unauthenticated_sender',
        },
        'dispatch_sender_auth_legacy_warn'
      );
    }
    return {
      context: result.capability,
      mode: result.mode,
    };
  }

  function mapDispatchPrincipalAuthError(c: Context, error: unknown): Response | null {
    if (error instanceof DispatchPrincipalAuthError) {
      return apiError(c, error.httpStatus, error.code);
    }
    if (error instanceof Error && error.message === 'dispatch_sender_auth_mode_invalid') {
      return apiError(c, 500, 'dispatch_sender_auth_mode_invalid');
    }
    return null;
  }

  function boardPrincipalProofFromHeaders(c: Context): boardAuthorityDb.BoardPrincipalProof {
    return { principal_token: c.req.header('x-board-principal-token')?.trim() };
  }

  function parseDispatchJsonBody(body: string): unknown {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error('dispatch_json_body_invalid');
    }
  }

  async function rejectNewDispatchIfDraining(c: Context): Promise<Response | null> {
    const drain = await workflowDb.getCauldronDrainState();
    if (drain.mode !== 'draining') return null;
    return apiError(
      c,
      503,
      'Cauldron is draining; new dispatch is disabled',
      `active_leases=${String(drain.activeLeaseCount)} active_runs=${String(drain.activeRunCount)}`
    );
  }

  /**
   * Validate that a caller-supplied `cwd` is rooted at a registered codebase path.
   * This prevents path traversal -- callers cannot read/write outside known project roots.
   */
  async function validateCwd(cwd: string): Promise<boolean> {
    const codebases = await codebaseDb.listCodebases();
    const normalizedCwd = normalize(cwd);
    return codebases.some(cb => {
      const base = normalize(cb.default_cwd);
      return normalizedCwd === base || normalizedCwd.startsWith(base + sep);
    });
  }

  // CORS for Web UI -- allow-all is fine for a single-developer tool.
  // Override with WEB_UI_ORIGIN env var to restrict if exposing publicly.
  function operatorAuthDisabled(): boolean {
    return process.env.ARCHON_OPERATOR_AUTH_DISABLED === 'true';
  }

  function privateApiRequiresOperatorToken(): boolean {
    return Boolean(process.env.ARCHON_OPERATOR_TOKEN) || process.env.NODE_ENV === 'production';
  }

  function isPublicApiPath(pathname: string): boolean {
    return (
      pathname === '/api/health' ||
      pathname === '/api/openapi.json' ||
      pathname.startsWith('/api/public/')
    );
  }

  function getPresentedOperatorToken(c: Context): string | undefined {
    const bearer = c.req
      .header('authorization')
      ?.match(/^Bearer\s+(.+)$/i)?.[1]
      ?.trim();
    return bearer || c.req.header('x-archon-operator-token')?.trim();
  }

  function envList(name: string): string[] {
    return (process.env[name] ?? '')
      .split(',')
      .map(value => value.trim().toLowerCase())
      .filter(Boolean);
  }

  function hostWithoutPort(host: string | undefined): string {
    return (host ?? '').split(':')[0]?.toLowerCase() ?? '';
  }

  function isAllowedAccessEmail(c: Context): boolean {
    const operatorHosts = envList('ARCHON_OPERATOR_ACCESS_HOSTS');
    const operatorEmails = envList('ARCHON_OPERATOR_EMAILS');
    if (operatorHosts.length === 0 || operatorEmails.length === 0) return false;

    const host = hostWithoutPort(c.req.header('host'));
    if (!operatorHosts.includes(host)) return false;

    const email = c.req.header('cf-access-authenticated-user-email')?.trim().toLowerCase();
    return Boolean(email && operatorEmails.includes(email));
  }

  function publicTimestamp(value: Date | string | null): string | null {
    if (value === null) return null;
    return value instanceof Date ? value.toISOString() : value;
  }

  /**
   * Convert a duration shortcut (e.g. "14d", "7d", "12h", "30m") OR an ISO
   * timestamp into an ISO cutoff string suitable for direct binding into
   * `started_at < $1`. Returns null when the input is neither a recognized
   * shortcut nor a parseable ISO timestamp (the caller should surface 400).
   *
   * Why this lives in the API handler layer (Option A from the parent WO):
   * bulkDeleteArchivedFailedRuns binds the cutoff directly into Postgres with
   * no parsing of its own. Without this guard a caller passing "14d" would
   * cause a Postgres cast error. Keeping it in the API layer lets callers stay
   * human-readable without touching the DB function.
   */
  function parseDurationToIso(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    // ISO timestamp passthrough: anything Date.parse can read AND that does
    // NOT match the duration-shortcut shape we know about.
    const shortcutMatch = /^(\d+)([smhd])$/i.exec(trimmed);
    if (shortcutMatch?.[1] && shortcutMatch[2]) {
      const amount = Number(shortcutMatch[1]);
      const unit = shortcutMatch[2].toLowerCase();
      if (!Number.isFinite(amount) || amount < 0) return null;
      const unitMs: Record<string, number> = {
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
      };
      const ms = unitMs[unit];
      if (ms === undefined) return null;
      return new Date(Date.now() - amount * ms).toISOString();
    }
    const ts = Date.parse(trimmed);
    if (Number.isNaN(ts)) return null;
    return new Date(ts).toISOString();
  }

  type PublicWorkflowNodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

  interface PublicWorkflowNode {
    label: string;
    status: PublicWorkflowNodeStatus;
    updated_at: string;
  }

  function publicTitleFromIdentifier(identifier: string | null | undefined): string {
    const raw = (identifier ?? '').trim();
    if (!raw) return 'Cauldron Workflow';

    const words = raw
      .replace(/[\\/]+/g, ' ')
      .replace(/[^a-zA-Z0-9 _.-]+/g, ' ')
      .split(/[-_.\s]+/)
      .filter(Boolean)
      .filter(word => !['bdc', 'archon', 'cauldron'].includes(word.toLowerCase()))
      .filter(word => !/^wo$/i.test(word))
      .filter(word => !/^[0-9a-f]{8,}$/i.test(word))
      .slice(0, 8);

    if (words.length === 0) return 'Cauldron Workflow';

    return words
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ')
      .slice(0, 80);
  }

  function publicNodeStatusForEvent(eventType: string): PublicWorkflowNodeStatus | null {
    switch (eventType) {
      case 'node_started':
      case 'step_started':
        return 'running';
      case 'node_completed':
      case 'node_completed_with_warning':
      case 'step_completed':
        return 'completed';
      case 'node_failed':
      case 'step_failed':
        return 'failed';
      case 'node_skipped':
      case 'step_skipped':
        return 'skipped';
      default:
        return null;
    }
  }

  function sanitizeWorkflowNodesForPublic(
    events: Awaited<ReturnType<typeof workflowEventDb.listWorkflowEvents>>
  ): PublicWorkflowNode[] {
    const nodes = new Map<string, PublicWorkflowNode>();

    for (const event of events) {
      if (!event.step_name) continue;
      const status = publicNodeStatusForEvent(event.event_type);
      if (!status) continue;

      const label = publicTitleFromIdentifier(event.step_name);
      nodes.set(event.step_name, {
        label,
        status,
        updated_at: publicTimestamp(event.created_at) ?? '',
      });
    }

    return [...nodes.values()].slice(0, 8);
  }

  function workflowRunTaskClass(run: WorkflowRun): string | undefined {
    const rawTaskClass = run.metadata.task_class ?? run.metadata.taskClass;
    if (typeof rawTaskClass !== 'string') return undefined;
    const taskClass = rawTaskClass.trim();
    return taskClass.length > 0 ? taskClass : undefined;
  }

  async function sanitizeWorkflowRunForPublic(run: WorkflowRun): Promise<{
    workflow_label: string;
    status: WorkflowRun['status'];
    started_at: string;
    completed_at: string | null;
    last_activity_at: string | null;
    nodes: PublicWorkflowNode[];
  }> {
    let nodes: PublicWorkflowNode[] = [];
    try {
      const events = await workflowEventDb.listWorkflowEvents(run.id);
      nodes = sanitizeWorkflowNodesForPublic(events);
    } catch (error) {
      getLog().warn({ err: error, runStatus: run.status }, 'public_workflow_nodes_unavailable');
    }

    return {
      workflow_label: publicTitleFromIdentifier(run.workflow_name),
      status: run.status,
      started_at: publicTimestamp(run.started_at) ?? '',
      completed_at: publicTimestamp(run.completed_at),
      last_activity_at: publicTimestamp(run.last_activity_at),
      nodes,
    };
  }

  app.use('/api/*', cors({ origin: process.env.WEB_UI_ORIGIN || '*' }));

  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'OPTIONS' || operatorAuthDisabled() || isPublicApiPath(c.req.path)) {
      return next();
    }

    if (!privateApiRequiresOperatorToken()) {
      return next();
    }

    if (isAllowedAccessEmail(c)) {
      return next();
    }

    const expectedToken = process.env.ARCHON_OPERATOR_TOKEN;
    if (!expectedToken) {
      return apiError(
        c,
        503,
        'Operator token is required but ARCHON_OPERATOR_TOKEN is not configured'
      );
    }

    if (getPresentedOperatorToken(c) !== expectedToken) {
      return apiError(c, 401, 'Missing or invalid operator token');
    }

    return next();
  });

  // Shared lock/dispatch/error handling for message and workflow endpoints
  /** Maximum allowed upload size per file (10 MB) */
  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
  /** Maximum number of files per message (enforced server-side) */
  const MAX_FILES_PER_MESSAGE = 5;
  /**
   * Binary (non-text) MIME types explicitly allowed for upload.
   * All text/* types are accepted separately via isAllowedUploadType().
   */
  const ALLOWED_UPLOAD_BINARY_MIME_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'application/pdf',
    // application/json is a structured text type browsers may report for .json files
    'application/json',
  ]);

  /** Extensions accepted when browser reports an empty MIME type (code/config files). */
  const ALLOWED_UPLOAD_EXTENSIONS = new Set([
    '.md',
    '.txt',
    '.csv',
    '.xml',
    '.html',
    '.htm',
    '.json',
    '.yaml',
    '.yml',
    '.toml',
    '.ini',
    '.cfg',
    '.conf',
    '.env',
    '.log',
    '.css',
    '.js',
    '.jsx',
    '.ts',
    '.tsx',
    '.mjs',
    '.cjs',
    '.py',
    '.rb',
    '.go',
    '.java',
    '.c',
    '.cpp',
    '.cc',
    '.cxx',
    '.h',
    '.hpp',
    '.cs',
    '.php',
    '.sh',
    '.bash',
    '.zsh',
    '.fish',
    '.rs',
    '.swift',
    '.kt',
    '.scala',
    '.r',
    '.sql',
  ]);

  /** Returns true if the MIME type is allowed for upload. */
  function isAllowedUploadType(mimeType: string, fileName: string): boolean {
    // All text/* types are acceptable (covers .md, .py, .rs, .go, .sh, .yaml, etc.)
    if (mimeType.startsWith('text/')) return true;
    if (ALLOWED_UPLOAD_BINARY_MIME_TYPES.has(mimeType)) return true;
    // Browsers assign empty MIME types to many code/config extensions -- fall back to extension
    if (!mimeType) {
      const dotIndex = fileName.lastIndexOf('.');
      if (dotIndex !== -1) {
        return ALLOWED_UPLOAD_EXTENSIONS.has(fileName.slice(dotIndex).toLowerCase());
      }
    }
    return false;
  }

  /**
   * Pre-dispatch validation for `/workflow run <name>` messages.
   *
   * The orchestrator dispatch is asynchronous (fire-behind-a-lock), so by the
   * time the command handler discovers that a workflow name does not resolve,
   * the HTTP response has already returned `dispatched: true`. That produced
   * false "run started" reports for retired lanes (2026-07-07 incident:
   * fire.ps1 got accepted:true for bdc-feature-development-fusion-cx-qwen,
   * no run row was ever created). Validate the name synchronously here and
   * reject BEFORE accepting the dispatch.
   *
   * Fails open on discovery errors -- a broken YAML tree is surfaced by the
   * command handler in-conversation; only a definitive "no such workflow"
   * (or ambiguous name) is rejected at the API boundary.
   */
  const WORKFLOW_RUN_COMMAND = /^\/workflow\s+run\s+(\S+)/;
  const DEFAULT_BUILDER_MONITOR_URL =
    'https://n8n.bluedevilcollectibles.com/webhook/builder-status';

  function workflowHasCodexNode(workflow: WorkflowDefinition): boolean {
    return (
      workflow.provider === 'codex' ||
      (workflow.nodes ?? []).some(node => 'provider' in node && node.provider === 'codex')
    );
  }

  async function postBuilderStatusAlert(
    action: string,
    detail: string,
    woId?: string | null
  ): Promise<void> {
    const url = process.env.BUILDER_MONITOR_WEBHOOK_URL ?? DEFAULT_BUILDER_MONITOR_URL;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          builder: 'Cauldron',
          wo_id: woId ?? 'unknown',
          action,
          detail,
        }),
      });
      if (!response.ok) {
        getLog().warn(
          { status: response.status, action, woId },
          'builder_status_alert_post_failed'
        );
      }
    } catch (error) {
      getLog().warn({ err: error, action, woId }, 'builder_status_alert_post_failed');
    }
  }

  async function validateWorkflowRunTarget(
    message: string,
    codebaseId?: string | null
  ): Promise<
    | { valid: true; isolationHints?: HandleMessageContext['isolationHints'] }
    | { valid: false; error: string; httpStatus?: number }
  > {
    const match = WORKFLOW_RUN_COMMAND.exec(message.trim());
    if (!match) return { valid: true };
    const workflowName = match[1];

    // Parse and validate the optional atomic `--from origin/<branch>` override
    // BEFORE resolving the workflow so malformed/unsafe input fails closed even
    // when workflow discovery later degrades. The single validated hints object
    // is threaded through to dispatch (never re-parsed downstream).
    const branchOverride = await parseWorkflowRunBranchOverride(message);
    if (branchOverride.kind === 'error') {
      return { valid: false, error: branchOverride.error };
    }
    const isolationHints = branchOverride.kind === 'ok' ? branchOverride.hints : undefined;

    // Mirror the command handler's cwd resolution (handleWorkflowCommand):
    // codebase default_cwd when known, else the workspaces root. A fresh
    // conversation has no per-conversation cwd yet.
    let cwd: string | undefined;
    if (codebaseId) {
      try {
        const codebase = await codebaseDb.getCodebase(codebaseId);
        cwd = codebase?.default_cwd ?? undefined;
      } catch (error) {
        getLog().warn({ err: error, codebaseId }, 'dispatch_precheck_codebase_lookup_failed');
      }
    }
    if (!cwd) cwd = getArchonWorkspacesPath();

    let workflows: WorkflowDefinition[];
    try {
      const discovery = await discoverWorkflowsWithConfig(cwd, loadConfig);
      workflows = discovery.workflows.map(ws => ws.workflow);
    } catch (error) {
      getLog().warn({ err: error, cwd, workflowName }, 'dispatch_precheck_discovery_failed');
      // An explicit branch override also requires proving the resolved workflow
      // permits worktrees. If discovery is unavailable, that policy cannot be
      // checked, so fail closed before creating a conversation. Preserve the
      // existing graceful-degradation behavior for fires without an override.
      if (isolationHints) {
        return {
          valid: false,
          error: `Workflow discovery failed; cannot safely apply --from/--from-branch for "${workflowName}".`,
        };
      }
      return { valid: true, isolationHints };
    }

    let workflow: WorkflowDefinition | undefined;
    try {
      workflow = resolveWorkflowName(workflowName, workflows);
    } catch (error) {
      // resolveWorkflowName throws on ambiguous names -- reject with candidates.
      return { valid: false, error: (error as Error).message };
    }
    if (!workflow) {
      getLog().warn({ workflowName, cwd }, 'dispatch_precheck_workflow_not_found');
      return {
        valid: false,
        error: `Workflow "${workflowName}" not found. Use GET /api/workflows to list available workflows.`,
      };
    }
    // A branch override requests task-worktree isolation. A workflow that pins
    // `worktree.enabled: false` would run in the live checkout, so honoring the
    // override is impossible -- reject before anything is created.
    if (isolationHints && workflow.worktree?.enabled === false) {
      getLog().warn(
        { workflowName },
        'dispatch_precheck_branch_override_rejected_worktree_disabled'
      );
      return {
        valid: false,
        error: `Workflow "${workflowName}" runs in the live checkout (worktree.enabled: false); --from/--from-branch cannot be applied.`,
      };
    }
    if (workflowHasCodexNode(workflow)) {
      getLog().info({ workflowName }, 'codex_dispatch_gate_consult');
      try {
        const gate = await checkCodexDispatchGate();
        if (gate.fresh) return { valid: true, isolationHints };
        getLog().warn({ workflowName, reason: gate.reason }, 'codex_dispatch_gate_refused');
      } catch (error) {
        getLog().warn({ err: error, workflowName }, 'codex_dispatch_gate_failed');
      }
      return { valid: false, error: 'codex_auth_stale', httpStatus: 503 };
    }
    return { valid: true, isolationHints };
  }

  async function dispatchToOrchestrator(
    conversationId: string,
    message: string,
    extraContext?: Omit<HandleMessageContext, 'isolationHints'>,
    filesToCleanup?: { files: AttachedFile[]; uploadDir: string },
    isolationHintsOverride?: HandleMessageContext['isolationHints']
  ): Promise<{ accepted: boolean; status: string }> {
    // Default: thread isolation keyed to this conversation. When an atomic fire
    // supplied a validated `--from origin/<branch>` override, use its task hints
    // instead, always keying workflowId to this conversation (the worker gets its
    // own unique id later in dispatchBackgroundWorkflow).
    const isolationHints: NonNullable<HandleMessageContext['isolationHints']> =
      isolationHintsOverride
        ? { ...isolationHintsOverride, workflowId: conversationId }
        : { workflowType: 'thread', workflowId: conversationId };
    const result = await lockManager.acquireLock(conversationId, async () => {
      // Emit lock:true at handler start so the UI knows processing has begun.
      // Fire-and-forget -- if no SSE stream is connected yet, the event is buffered.
      webAdapter.emitLockEvent(conversationId, true);
      try {
        await handleMessage(webAdapter, conversationId, message, {
          isolationHints,
          ...extraContext,
        });
      } catch (error) {
        getLog().error({ err: error, conversationId }, 'handle_message_failed');
        try {
          await webAdapter.emitSSE(
            conversationId,
            JSON.stringify({
              type: 'error',
              message: `Failed to process message: ${(error as Error).message ?? 'unknown error'}. Try /reset if the problem persists.`,
              classification: 'transient',
              timestamp: Date.now(),
            })
          );
        } catch (sseError) {
          getLog().error({ err: sseError, conversationId }, 'sse_error_emit_failed');
        }
      } finally {
        await webAdapter.emitLockEvent(conversationId, false);
        // Clean up uploaded files AFTER handleMessage completes so the AI subprocess
        // has had a chance to read them. Doing this in the HTTP handler's finally block
        // would delete files while the fire-and-forget lock handler is still running.
        if (filesToCleanup) {
          for (const f of filesToCleanup.files) {
            await unlink(f.path).catch((err: NodeJS.ErrnoException) => {
              if (err.code !== 'ENOENT') {
                getLog().warn({ err, filePath: f.path, conversationId }, 'upload.cleanup_failed');
              }
            });
          }
          // Remove the now-empty upload directory for this conversation.
          await rm(filesToCleanup.uploadDir, { recursive: true, force: true }).catch(
            (err: NodeJS.ErrnoException) => {
              if (err.code !== 'ENOENT') {
                getLog().warn(
                  { err, uploadDir: filesToCleanup.uploadDir, conversationId },
                  'upload.dir_cleanup_failed'
                );
              }
            }
          );
        }
      }
    });

    if (result.status === 'queued-conversation' || result.status === 'queued-capacity') {
      // Intentionally fire-and-forget: the lock-acquire signal (locked: true) is sent
      // optimistically so the UI shows a queued state immediately. It is not awaited
      // because we want the HTTP response to return before the SSE write completes.
      // The lock-release signal (locked: false) IS awaited inside the task callback
      // above to guarantee ordering -- all tool results and flush must precede the
      // release event on the SSE stream.
      webAdapter.emitLockEvent(conversationId, true);
    }

    return { accepted: true, status: result.status };
  }

  /**
   * Re-enter the workflow executor directly after a paused approval gate is
   * resolved, so a web-dispatched workflow continues (approve) or runs its
   * on_reject prompt (reject) without the user having to re-run the workflow
   * command. The CLI's `workflowApproveCommand` / `workflowRejectCommand`
   * already auto-resume via `workflowRunCommand({ resume: true })`; this is the
   * web-side equivalent without going back through the natural-language
   * orchestrator.
   *
   * Returns `true` when a resume dispatch was initiated, `false` otherwise (no
   * worker conversation on the run, parent conversation deleted, parent was on
   * a non-web platform, workflow definition missing, or executor launch threw).
   * Failures are non-fatal: the gate
   * decision is recorded regardless; when this returns `false` the response
   * text instructs the user to re-run the workflow command.
   *
   * **Cross-adapter guard**: only web-sourced parents qualify.
   * `dispatchToOrchestrator` is wired to the web adapter + its lock manager,
   * so a Slack / Telegram / GitHub / Discord run being approved from the
   * dashboard must not route through it -- the Slack thread would never see
   * the resumed output. Non-web parents skip auto-resume and the originating
   * platform's own re-run flow applies.
   */
  async function tryAutoResumeRun(
    run: WorkflowRun,
    action: 'approve' | 'reject' | 'provider_wait'
  ): Promise<boolean> {
    if (!run.parent_conversation_id) return false;
    if (!run.conversation_id || !run.working_path) return false;
    // Literal event names per action -- greppable for ops tooling. Keeping the
    // branch explicit rather than templating avoids the earlier 3-segment
    // `api.workflow_*.dispatched` shape that broke `{domain}.{action}_{state}`.
    const events =
      action === 'approve'
        ? {
            dispatched: 'api.workflow_approve_auto_resume_dispatched' as const,
            skippedNoPlatformConv:
              'api.workflow_approve_auto_resume_skipped_no_platform_conv' as const,
            skippedNonWebParent: 'api.workflow_approve_auto_resume_skipped_non_web_parent' as const,
            failed: 'api.workflow_approve_auto_resume_failed' as const,
            missingWorker: 'api.workflow_approve_auto_resume_skipped_no_worker_conv' as const,
            missingWorkflow: 'api.workflow_approve_auto_resume_skipped_missing_workflow' as const,
            executorStarted: 'api.workflow_approve_direct_resume_started' as const,
            executorFailed: 'api.workflow_approve_direct_resume_failed' as const,
          }
        : action === 'reject'
          ? {
              dispatched: 'api.workflow_reject_auto_resume_dispatched' as const,
              skippedNoPlatformConv:
                'api.workflow_reject_auto_resume_skipped_no_platform_conv' as const,
              skippedNonWebParent:
                'api.workflow_reject_auto_resume_skipped_non_web_parent' as const,
              failed: 'api.workflow_reject_auto_resume_failed' as const,
              missingWorker: 'api.workflow_reject_auto_resume_skipped_no_worker_conv' as const,
              missingWorkflow: 'api.workflow_reject_auto_resume_skipped_missing_workflow' as const,
              executorStarted: 'api.workflow_reject_direct_resume_started' as const,
              executorFailed: 'api.workflow_reject_direct_resume_failed' as const,
            }
          : {
              dispatched: 'api.provider_wait_auto_resume_dispatched' as const,
              skippedNoPlatformConv:
                'api.provider_wait_auto_resume_skipped_no_platform_conv' as const,
              skippedNonWebParent: 'api.provider_wait_auto_resume_skipped_non_web_parent' as const,
              failed: 'api.provider_wait_auto_resume_failed' as const,
              missingWorker: 'api.provider_wait_auto_resume_skipped_no_worker_conv' as const,
              missingWorkflow: 'api.provider_wait_auto_resume_skipped_missing_workflow' as const,
              executorStarted: 'api.provider_wait_direct_resume_started' as const,
              executorFailed: 'api.provider_wait_direct_resume_failed' as const,
            };
    try {
      const parentConv = await conversationDb.getConversationById(run.parent_conversation_id);
      const workerConv = await conversationDb.getConversationById(run.conversation_id);
      const platformConvId = parentConv?.platform_conversation_id;
      if (!platformConvId) {
        // parentConv === null is a data-integrity signal (the parent
        // conversation was deleted while the run was paused) -- worth
        // surfacing at info level so operators notice. Missing
        // platform_conversation_id on an existing row shouldn't happen and
        // stays at debug.
        const logFn =
          parentConv === null ? getLog().info.bind(getLog()) : getLog().debug.bind(getLog());
        logFn(
          {
            runId: run.id,
            parentConversationId: run.parent_conversation_id,
            parentDeleted: parentConv === null,
          },
          events.skippedNoPlatformConv
        );
        return false;
      }
      if (parentConv.platform_type !== 'web') {
        getLog().debug(
          {
            runId: run.id,
            parentConversationId: run.parent_conversation_id,
            platformType: parentConv.platform_type,
          },
          events.skippedNonWebParent
        );
        return false;
      }
      const workerPlatformConvId = workerConv?.platform_conversation_id;
      if (!workerConv || !workerPlatformConvId || workerConv.platform_type !== 'web') {
        getLog().warn(
          {
            runId: run.id,
            workerConversationId: run.conversation_id,
            workerPlatformType: workerConv?.platform_type,
          },
          events.missingWorker
        );
        return false;
      }

      const resolvedWorkflowName =
        (await resolveWebLane({
          workflowName: run.workflow_name.trim() || undefined,
          task_class: workflowRunTaskClass(run),
          routerYamlPath: join(run.working_path, 'config', 'router.yaml'),
        })) ?? run.workflow_name;

      const discovery = await discoverWorkflowsWithConfig(run.working_path, loadConfig);
      const workflow = discovery.workflows.find(
        item => item.workflow.name === resolvedWorkflowName
      )?.workflow;
      if (!workflow) {
        getLog().warn(
          {
            runId: run.id,
            workflowName: resolvedWorkflowName,
            workingPath: run.working_path,
            loaderErrors: discovery.errors,
          },
          events.missingWorkflow
        );
        return false;
      }

      webAdapter.setConversationDbId(workerPlatformConvId, workerConv.id);
      const unsubscribeBridge = webAdapter.setupEventBridge(workerPlatformConvId, platformConvId);
      const execution =
        action === 'provider_wait'
          ? executeWorkflow(
              createWorkflowDeps(),
              webAdapter,
              workerPlatformConvId,
              run.working_path,
              workflow,
              run.user_message ?? '',
              workerConv.id,
              run.codebase_id ?? undefined,
              undefined,
              undefined,
              parentConv.id,
              run
            )
          : executeWorkflow(
              createWorkflowDeps(),
              webAdapter,
              workerPlatformConvId,
              run.working_path,
              workflow,
              run.user_message ?? '',
              workerConv.id,
              run.codebase_id ?? undefined,
              undefined,
              undefined,
              parentConv.id
            );
      void execution
        .then(result => {
          if (result.success && 'summary' in result && result.summary) {
            return webAdapter.sendMessage(platformConvId, result.summary, {
              category: 'workflow_result',
              segment: 'new',
              workflowResult: {
                workflowName: resolvedWorkflowName,
                runId: run.id,
              },
            });
          }
          return undefined;
        })
        .catch(err => {
          getLog().warn({ err: err as Error, runId: run.id }, events.executorFailed);
        })
        .finally(() => {
          unsubscribeBridge();
        });
      getLog().info(
        { runId: run.id, workflowName: resolvedWorkflowName, platformConvId, workerPlatformConvId },
        events.executorStarted
      );
      return true;
    } catch (err) {
      getLog().warn({ err: err as Error, runId: run.id }, events.failed);
      return false;
    }
  }

  if (process.env.NODE_ENV !== 'test' && providerWaitSchedulerTimer === undefined) {
    const schedulerStore = createWorkflowDeps().store;
    const schedulerOwnerId = `provider-wait:${randomUUID()}`;
    const configuredInterval = Number.parseInt(
      process.env.ARCHON_PROVIDER_WAIT_POLL_INTERVAL_MS ?? '',
      10
    );
    const intervalMs =
      Number.isInteger(configuredInterval) && configuredInterval > 0 ? configuredInterval : 15_000;
    let schedulerInFlight = false;
    const tick = async (): Promise<void> => {
      if (schedulerInFlight) return;
      schedulerInFlight = true;
      try {
        const result = await processDueProviderWaits(
          schedulerStore,
          async wait => {
            const run = await schedulerStore.getWorkflowRun(wait.runId);
            if (run?.status !== 'waiting_provider') {
              throw new Error(`provider_wait_run_not_waiting: ${wait.runId}`);
            }
            const dispatched = await tryAutoResumeRun(run, 'provider_wait');
            if (!dispatched) throw new Error(`provider_wait_resume_not_dispatched: ${wait.runId}`);
          },
          { ownerId: schedulerOwnerId }
        );
        if (result.due > 0) getLog().info(result, 'api.provider_wait_scheduler_tick');
      } catch (error) {
        getLog().error({ err: error as Error }, 'api.provider_wait_scheduler_failed');
      } finally {
        schedulerInFlight = false;
      }
    };
    providerWaitSchedulerTimer = setInterval(() => void tick(), intervalMs);
    providerWaitSchedulerTimer.unref?.();
    void tick();
  }

  // Taskmaster Slice 1 loop (WO-HARNESS-TASKMASTER-SLICE1-01, M-133).
  // Skeleton cloned from the provider-wait scheduler above; the timer
  // singleton, inFlight guard, and TASKMASTER_INTERVAL_MS handling
  // (default 60000, 0 = off) live in ../taskmaster/loop.ts.
  if (process.env.NODE_ENV !== 'test') {
    startTaskmaster(randomUUID());
    // External dead-man checker (binding condition 5 / Q4): lives in the
    // Overseer package and observes the taskmaster ONLY via
    // GET /api/taskmaster/status over HTTP -- never via in-process state.
    // Started alongside the taskmaster (not inside startOverseerRuntime,
    // which is gated on OVERSEER_ENABLED) so the watcher is always on when
    // the taskmaster ships scheduled ON. Persistent episode state lives in
    // the checker's module-scope runtime; TASKMASTER_DEADMAN_INTERVAL_MS=0
    // disables (default 60000).
    startTaskmasterDeadmanChecker();
    // Operator inbox consumer (WO-HARNESS-OPERATOR-INBOX-CONSUMER-01 / #1455).
    // Drains recipient=operator queued dispatch messages that producers already
    // write (Overseer run_report, Taskmaster digests, dead-man escalations).
    // Same scheduler skeleton (singleton + inFlight + env interval 0=off);
    // human surface is durable JSONL under ARCHON_HOME/operator-inbox/ --
    // Telegram/SMS stay dark per #1456. OPERATOR_INBOX_INTERVAL_MS default 60000.
    startOperatorInboxConsumer();
  }

  // GET /api/taskmaster/status - pause state, epoch, tick health
  registerOpenApiRoute(getTaskmasterStatusRoute, async c => {
    try {
      const control = await taskmasterDb.getPauseState();
      const runtime = getTaskmasterRuntime();
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const actions = await taskmasterDb.getActionsSince(dayAgo);
      const lastTickAtMs = runtime?.state.deadman.lastTickAtMs ?? null;
      return c.json({
        pause_state: control.pause_state,
        pause_scope: control.pause_scope,
        pause_reason: control.pause_reason,
        pause_actor: control.pause_actor,
        epoch: control.epoch,
        tick_health: getTickHealth(),
        interval_ms: runtime?.intervalMs ?? 0,
        last_tick_at: lastTickAtMs === null ? null : new Date(lastTickAtMs).toISOString(),
        headroom_state: runtime?.lastTickResult?.headroomState ?? null,
        effects_last_24h: actions.filter(a => a.outcome === 'sent').length,
      });
    } catch (error) {
      getLog().error({ err: error }, 'taskmaster_status_failed');
      return apiError(c, 500, 'Failed to read taskmaster status');
    }
  });

  // GET /api/taskmaster/register - read-only adoption projection.
  registerOpenApiRoute(getTaskmasterRegisterRoute, async c => {
    try {
      const query = getValidatedQuery(c, registerListQuerySchema);
      const filter: taskmasterDb.TmAdoptionFilter = {};
      if (query.priority !== undefined) filter.priority = query.priority;
      if (query.owner !== undefined) {
        filter.owner_login = query.owner === 'UNKNOWN' ? null : query.owner;
      }
      if (query.blocked !== undefined) filter.blocked = query.blocked === 'true';

      const [allRows, total] = await Promise.all([
        taskmasterDb.getAdoption(filter),
        taskmasterDb.getAdoptionCount(filter),
      ]);
      return c.json({
        rows: allRows.slice(query.offset, query.offset + query.limit),
        total,
        limit: query.limit,
        offset: query.offset,
      });
    } catch (error) {
      getLog().error({ err: error }, 'taskmaster_register_list_failed');
      return apiError(c, 500, 'Failed to read taskmaster register');
    }
  });

  // GET /api/taskmaster/register/meta - read-only register health.
  registerOpenApiRoute(getTaskmasterRegisterMetaRoute, async c => {
    try {
      const [meta, control, partialCount, unaddressedXo] = await Promise.all([
        taskmasterDb.getAdoptionMeta(),
        taskmasterDb.getPauseState(),
        taskmasterDb.getAdoptionPartialCount(),
        // DAL uses LOWER(TRIM(sender)) and LOWER(TRIM(recipient)); raw matching undercounts.
        taskmasterDb.getUnaddressedXoCount(),
      ]);
      const unavailable = meta?.committed_snapshot_id == null;
      const complete = meta?.complete === 1;
      const freshness: ('FRESH' | 'STALE' | 'PARTIAL' | 'UNAVAILABLE')[] = unavailable
        ? ['UNAVAILABLE']
        : [
            complete &&
            meta.rebuilt_at !== null &&
            Date.now() - new Date(meta.rebuilt_at).getTime() <= REGISTER_STALE_AFTER_MS
              ? 'FRESH'
              : 'STALE',
            ...(complete && partialCount > 0 ? (['PARTIAL'] as const) : []),
          ];
      return c.json({
        freshness,
        rebuilt_at: meta?.rebuilt_at ?? null,
        row_count: meta?.row_count ?? 0,
        partial_count: partialCount,
        pause_state: control.pause_state,
        unaddressed_xo: unaddressedXo,
      });
    } catch (error) {
      getLog().error({ err: error }, 'taskmaster_register_meta_failed');
      return apiError(c, 500, 'Failed to read taskmaster register metadata');
    }
  });

  // POST /api/taskmaster/pause - operator/John pauses effects
  registerOpenApiRoute(postTaskmasterPauseRoute, async c => {
    try {
      const body: { reason?: string; scope?: string; actor: string } = (getValidatedBody(
        c,
        taskmasterPauseBodySchema
      ) as { reason?: string; scope?: string; actor: string } | undefined) ?? { actor: 'operator' };
      const control = await taskmasterDb.setPauseState({
        pause_state: 'PAUSED',
        pause_scope: body.scope ?? 'effects',
        pause_reason: body.reason ?? null,
        pause_actor: body.actor,
      });
      return c.json({ pause_state: control.pause_state, epoch: control.epoch });
    } catch (error) {
      getLog().error({ err: error }, 'taskmaster_pause_failed');
      return apiError(c, 500, 'Failed to pause taskmaster');
    }
  });

  // POST /api/taskmaster/resume - John-authorized; epoch increments and
  // stale proposals are EXPIRED, never replayed.
  registerOpenApiRoute(postTaskmasterResumeRoute, async c => {
    try {
      const body: { actor: string; reason?: string } = (getValidatedBody(
        c,
        taskmasterResumeBodySchema
      ) as
        | { actor: string; reason?: string }
        | undefined) ?? {
        actor: 'john',
      };
      const { control, expiredProposals, audit } = await taskmasterDb.resetTaskmaster({
        actor: body.actor,
        reason: body.reason ?? null,
      });
      return c.json({
        pause_state: control.pause_state,
        epoch: control.epoch,
        expired_proposals: expiredProposals,
        audit_id: audit.id,
      });
    } catch (error) {
      getLog().error({ err: error }, 'taskmaster_resume_failed');
      return apiError(c, 500, 'Failed to resume taskmaster');
    }
  });

  // GET /api/conversations - List conversations
  registerOpenApiRoute(getConversationsRoute, async c => {
    try {
      const platformType = c.req.query('platform') ?? undefined;
      const codebaseId = c.req.query('codebaseId') ?? undefined;
      const conversations = await conversationDb.listConversations(
        50,
        platformType,
        codebaseId,
        true
      );
      return c.json(conversations);
    } catch (error) {
      getLog().error({ err: error }, 'list_conversations_failed');
      return apiError(c, 500, 'Failed to list conversations');
    }
  });

  // GET /api/conversations/:id - Get single conversation by platform conversation ID
  registerOpenApiRoute(getConversationRoute, async c => {
    const platformId = c.req.param('id') ?? '';
    try {
      const conv = await conversationDb.findConversationByPlatformId(platformId);
      if (!conv) {
        return apiError(c, 404, 'Conversation not found');
      }
      return c.json(conv);
    } catch (error) {
      getLog().error({ err: error, platformId }, 'get_conversation_failed');
      return apiError(c, 500, 'Failed to get conversation');
    }
  });

  // POST /api/conversations - Create new conversation
  // Accepts optional `message` field for atomic create+send (avoids ghost "Untitled" entries)
  registerOpenApiRoute(createConversationRoute, async c => {
    try {
      const { codebaseId, message } = getValidatedBody(c, createConversationBodySchema);

      if (message) {
        const drainRejection = await rejectNewDispatchIfDraining(c);
        if (drainRejection) return drainRejection;
      }

      // Validate codebase exists if provided
      if (codebaseId) {
        const codebase = await codebaseDb.getCodebase(codebaseId);
        if (!codebase) {
          return apiError(c, 400, 'Codebase not found', `No codebase with id "${codebaseId}"`);
        }
      }

      // Reject unknown workflow names and malformed/unsafe --from overrides
      // BEFORE creating the conversation or reporting dispatch success -- see
      // validateWorkflowRunTarget. The single validated isolation-hints object is
      // captured here and threaded into dispatch (never re-parsed).
      let dispatchIsolationHints: HandleMessageContext['isolationHints'];
      if (message) {
        const check = await validateWorkflowRunTarget(message, codebaseId);
        if (!check.valid) {
          return c.json({ accepted: false, dispatched: false, error: check.error }, 400);
        }
        dispatchIsolationHints = check.isolationHints;
      }

      const conversationId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const conversation = await conversationDb.getOrCreateConversation(
        'web',
        conversationId,
        codebaseId
      );
      webAdapter.setConversationDbId(conversation.platform_conversation_id, conversation.id);

      // If message provided, dispatch it atomically (avoids ghost "Untitled" conversations)
      if (message) {
        try {
          await messageDb.addMessage(conversation.id, 'user', message);
        } catch (e: unknown) {
          // Log only (no SSE warning) -- the SSE stream isn't connected yet for new conversations.
          // The existing /message endpoint emits a warning because the stream is guaranteed to be active.
          getLog().error({ err: e, conversationId: conversation.id }, 'message_persistence_failed');
        }

        // Set placeholder title immediately so the sidebar never shows "Untitled conversation"
        const placeholderTitle = message.length > 60 ? message.slice(0, 60) + '...' : message;
        await conversationDb.updateConversationTitle(conversation.id, placeholderTitle);

        // Generate proper AI title for non-command messages (fire-and-forget, overwrites placeholder)
        if (!message.startsWith('/')) {
          void generateAndSetTitle(
            conversation.id,
            message,
            conversation.ai_assistant_type,
            getArchonWorkspacesPath()
          );
        }

        const result = await dispatchToOrchestrator(
          conversation.platform_conversation_id,
          message,
          undefined,
          undefined,
          dispatchIsolationHints
        );

        return c.json({
          conversationId: conversation.platform_conversation_id,
          id: conversation.id,
          dispatched: true,
          ...result,
        });
      }

      return c.json({ conversationId: conversation.platform_conversation_id, id: conversation.id });
    } catch (error) {
      getLog().error({ err: error }, 'create_conversation_failed');
      return apiError(c, 500, 'Failed to create conversation');
    }
  });

  // PATCH /api/conversations/:id - Update conversation (title)
  registerOpenApiRoute(updateConversationRoute, async c => {
    const platformId = c.req.param('id') ?? '';
    const { title } = getValidatedBody(c, updateConversationBodySchema);
    try {
      const conv = await conversationDb.findConversationByPlatformId(platformId);
      if (!conv) {
        return apiError(c, 404, 'Conversation not found');
      }
      if (title !== undefined) {
        await conversationDb.updateConversationTitle(conv.id, title.slice(0, 255));
      }
      return c.json({ success: true });
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        return apiError(c, 404, 'Conversation not found');
      }
      getLog().error({ err: error }, 'update_conversation_failed');
      return apiError(c, 500, 'Failed to update conversation');
    }
  });

  // DELETE /api/conversations/:id - Soft delete
  registerOpenApiRoute(deleteConversationRoute, async c => {
    const platformId = c.req.param('id') ?? '';
    try {
      const conv = await conversationDb.findConversationByPlatformId(platformId);
      if (!conv) {
        return apiError(c, 404, 'Conversation not found');
      }
      await conversationDb.softDeleteConversation(conv.id);
      return c.json({ success: true });
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        return apiError(c, 404, 'Conversation not found');
      }
      getLog().error({ err: error }, 'delete_conversation_failed');
      return apiError(c, 500, 'Failed to delete conversation');
    }
  });

  // GET /api/conversations/:id/messages - Message history
  registerOpenApiRoute(listMessagesRoute, async c => {
    const platformConversationId = c.req.param('id') ?? '';
    const limit = Math.min(Number(c.req.query('limit') ?? '200'), 500);
    try {
      const conv = await conversationDb.findConversationByPlatformId(platformConversationId);
      if (!conv) {
        return apiError(c, 404, 'Conversation not found');
      }
      const messages = await messageDb.listMessages(conv.id, limit);
      // Normalize metadata: PostgreSQL JSONB auto-deserializes to object,
      // but frontend expects JSON string. SQLite returns string already.
      return c.json(
        messages.map(m => ({
          ...m,
          metadata: typeof m.metadata === 'string' ? m.metadata : JSON.stringify(m.metadata),
        }))
      );
    } catch (error) {
      getLog().error({ err: error }, 'list_messages_failed');
      return apiError(c, 500, 'Failed to list messages');
    }
  });

  // POST /api/conversations/:id/message - Send message
  // Manual body parsing: multipart uses parseBody(), JSON uses req.json().
  registerOpenApiRoute(sendMessageRoute, async c => {
    const drainRejection = await rejectNewDispatchIfDraining(c);
    if (drainRejection) return drainRejection;
    const conversationId = c.req.param('id') ?? '';

    // Reject conversation IDs that could be used for path traversal when building
    // the upload directory. Web conversation IDs are alphanumeric with hyphens only.
    if (!/^[\w-]+$/.test(conversationId)) {
      return c.json({ error: 'Invalid conversation ID' }, 400);
    }

    let message: string;
    const savedFiles: AttachedFile[] = [];
    let uploadDir = '';

    const contentType = c.req.header('content-type') ?? '';

    if (contentType.includes('multipart/form-data')) {
      let body: Record<string, string | File | (string | File)[]>;
      try {
        body = await c.req.parseBody({ all: true });
      } catch (parseErr: unknown) {
        getLog().warn({ err: parseErr, conversationId }, 'upload.parse_failed');
        return c.json({ error: 'Invalid multipart form data' }, 400);
      }

      const rawMessage = body.message;
      if (typeof rawMessage !== 'string' || !rawMessage) {
        return c.json({ error: 'message must be a non-empty string' }, 400);
      }
      message = rawMessage;

      const rawFiles = body.files;
      let fileList: (string | File)[];
      if (Array.isArray(rawFiles)) {
        fileList = rawFiles;
      } else if (rawFiles !== undefined) {
        fileList = [rawFiles];
      } else {
        fileList = [];
      }

      // Enforce server-side file count limit
      const fileEntries = fileList.filter((e): e is File => e instanceof File);
      if (fileEntries.length > MAX_FILES_PER_MESSAGE) {
        return c.json({ error: `Maximum ${String(MAX_FILES_PER_MESSAGE)} files per message` }, 400);
      }

      const archonHome = getArchonHome();
      uploadDir = join(archonHome, 'artifacts', 'uploads', conversationId);

      // Guard against path traversal in conversationId (belt-and-suspenders after regex above)
      if (!uploadDir.startsWith(archonHome + sep)) {
        return c.json({ error: 'Invalid conversation ID' }, 400);
      }

      // Validate all files before writing any to disk
      for (const entry of fileEntries) {
        const displayName = basename(entry.name).replace(/[^a-zA-Z0-9._-]/g, '_');
        // Server-side MIME type allowlist (client-side accept= is not a security boundary;
        // entry.type is the Content-Type supplied by the client and is not verified against
        // actual file contents -- suitable for a single-developer self-hosted tool)
        if (!isAllowedUploadType(entry.type, entry.name)) {
          return c.json(
            { error: `File "${displayName}" has an unsupported type: ${entry.type}` },
            400
          );
        }
        if (entry.size > MAX_UPLOAD_BYTES) {
          return c.json({ error: `File "${displayName}" exceeds the 10 MB size limit` }, 400);
        }
      }

      // Write files; on any failure clean up already-written files and surface the error
      try {
        await mkdir(uploadDir, { recursive: true });
        for (const entry of fileEntries) {
          const fileId = randomUUID();
          const safeName = basename(entry.name).replace(/[^a-zA-Z0-9._-]/g, '_');
          const filePath = join(uploadDir, `${fileId}_${safeName}`);
          await writeFile(filePath, Buffer.from(await entry.arrayBuffer()));
          // Normalise MIME: strip parameters to prevent prompt injection via crafted Content-Type
          const normalizedMime =
            entry.type.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
          savedFiles.push({
            path: filePath,
            // Use safeName for display to avoid prompt injection via crafted filenames
            name: safeName || fileId,
            mimeType: normalizedMime,
            size: entry.size,
          });
        }
      } catch (writeErr: unknown) {
        // Roll back any files written before the failure
        for (const f of savedFiles) {
          await unlink(f.path).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== 'ENOENT') {
              getLog().warn({ err, filePath: f.path, conversationId }, 'upload.rollback_failed');
            }
          });
        }
        getLog().error({ err: writeErr, conversationId }, 'upload.write_failed');
        return c.json({ error: 'Failed to save uploaded file. Check available disk space.' }, 500);
      }

      getLog().info({ conversationId, fileCount: savedFiles.length }, 'message.files_uploaded');
    } else {
      let body: { message?: unknown };
      try {
        body = await c.req.json();
      } catch (parseErr: unknown) {
        getLog().warn({ err: parseErr, conversationId }, 'message.json_parse_failed');
        return c.json({ error: 'Invalid JSON in request body' }, 400);
      }

      if (typeof body.message !== 'string' || !body.message) {
        return c.json({ error: 'message must be a non-empty string' }, 400);
      }
      message = body.message;
    }

    // Look up conversation for message persistence
    let conv: Awaited<ReturnType<typeof conversationDb.findConversationByPlatformId>> = null;
    try {
      conv = await conversationDb.findConversationByPlatformId(conversationId);
    } catch (e: unknown) {
      getLog().error({ err: e, conversationId }, 'conversation_lookup_failed');
    }

    // Persist user message and pass DB ID to adapter for assistant message persistence
    if (conv) {
      // Omit path from persisted metadata -- the on-disk file is ephemeral and will be
      // deleted after the AI processes it; storing stale paths would confuse future readers.
      const meta =
        savedFiles.length > 0
          ? { files: savedFiles.map(f => ({ name: f.name, mimeType: f.mimeType, size: f.size })) }
          : undefined;
      try {
        await messageDb.addMessage(conv.id, 'user', message, meta);
      } catch (e: unknown) {
        getLog().error({ err: e, conversationId: conv.id }, 'message_persistence_failed');
        try {
          await webAdapter.emitSSE(
            conversationId,
            JSON.stringify({
              type: 'warning',
              message: 'Message could not be saved to history',
              timestamp: Date.now(),
            })
          );
        } catch (sseErr: unknown) {
          getLog().error({ err: sseErr, conversationId: conv?.id }, 'sse_warning_double_failure');
        }
      }
      webAdapter.setConversationDbId(conversationId, conv.id);
    }

    // Pass savedFiles to dispatchToOrchestrator so cleanup happens inside the lock handler,
    // AFTER handleMessage completes -- not in the HTTP handler's finally block where the
    // fire-and-forget lock callback may still be running and the AI has not yet read the files.
    let extraContext: Omit<HandleMessageContext, 'isolationHints'> | undefined;
    let filesToCleanup: { files: AttachedFile[]; uploadDir: string } | undefined;
    if (savedFiles.length > 0) {
      extraContext = { attachedFiles: savedFiles };
      filesToCleanup = { files: savedFiles, uploadDir };
    }
    const result = await dispatchToOrchestrator(
      conversationId,
      message,
      extraContext,
      filesToCleanup
    );
    return c.json(result);
  });

  // =========================================================================
  // Blue Devil Dispatch endpoints
  // =========================================================================

  registerOpenApiRoute(createDispatchMessageRoute, async c => {
    try {
      const body = getValidatedBody(c, createDispatchMessageBodySchema);
      const assessment = assessDispatchMessageBody(body.task_type, body.body);
      if (!assessment.allowed) {
        return apiError(c, 400, assessment.reason ?? 'dispatch_message_body_rejected');
      }
      const canonicalBody = { ...body, recipient: body.recipient.trim().toLowerCase() };
      if (canonicalBody.task_type === 'board_motion') {
        const { capability, principal } = await DispatchNonSystemCapability.fromBoardProof({
          proof: boardPrincipalProofFromHeaders(c),
          purpose: 'motion_notification',
        });
        const pointer = await validateBoardMotionPointer(parseDispatchJsonBody(body.body));
        const canonicalMotionBody = JSON.stringify(pointer.payload);
        const message = await dispatchDb.createAuthenticatedMessage(capability, {
          correlation_id: canonicalBody.correlation_id,
          idempotency_key: deriveBoardMotionNotificationKey({
            motion_id: pointer.payload.motion_id,
            motion_revision_sha: pointer.motion_revision_sha,
          }),
          task_type: 'board_motion',
          recipient: 'board',
          body: canonicalMotionBody,
          not_before: canonicalBody.not_before ?? null,
          priority: canonicalBody.priority,
          recipient_alias: 'board',
          motion_id: pointer.payload.motion_id,
          motion_revision_sha: pointer.motion_revision_sha,
        });
        await boardAuthorityDb.appendBoardAuditEvent({
          event_type: 'motion_notification_enqueued',
          actor_principal_id: principal.principal_id,
          actor_seat_id: principal.seat_id,
          motion_id: pointer.payload.motion_id,
          motion_revision_sha: pointer.motion_revision_sha,
          details: {
            dispatch_message_id: message.id,
            file_path: pointer.payload.file_path,
            title: pointer.payload.title,
            canonical_commit_sha: pointer.commit_sha,
          },
        });
        return c.json(message);
      }
      if (canonicalBody.task_type === 'agent_message' && canonicalBody.recipient === 'board') {
        const { capability, principal } = await DispatchNonSystemCapability.fromBoardProof({
          proof: boardPrincipalProofFromHeaders(c),
          purpose: 'petition',
        });
        const petitionBody = parseDispatchJsonBody(body.body);
        const petition = await validateBoardPetitionPointer(petitionBody);
        const message = await dispatchDb.createAuthenticatedMessage(capability, {
          correlation_id: canonicalBody.correlation_id,
          idempotency_key: canonicalBody.idempotency_key,
          task_type: canonicalBody.task_type,
          recipient: canonicalBody.recipient,
          body: JSON.stringify({
            motion_id: petition.motion_id,
            file_path: petition.file_path,
            requested_action: petition.requested_action,
          }),
          not_before: canonicalBody.not_before ?? null,
          priority: canonicalBody.priority,
          recipient_alias: 'board',
          motion_id: petition.motion_id,
          motion_revision_sha: petition.motion_revision_sha,
          subject_key: canonicalBody.subject_key,
          repeat_reason: canonicalBody.repeat_reason,
        });
        await recordBoardPetitionDelivery({
          actor_principal_id: principal.principal_id,
          actor_seat_id: principal.seat_id,
          body: petitionBody,
          dispatch_message_id: message.id,
        });
        return c.json(message);
      }
      const { context } = resolveDispatchHttpSenderContext(c, canonicalBody.sender);
      const message = await dispatchDb.createAuthenticatedMessage(context, {
        correlation_id: canonicalBody.correlation_id,
        idempotency_key: canonicalBody.idempotency_key,
        task_type: canonicalBody.task_type,
        recipient: canonicalBody.recipient,
        body: canonicalBody.body,
        not_before: canonicalBody.not_before ?? null,
        priority: canonicalBody.priority,
        subject_key: canonicalBody.subject_key,
        repeat_reason: canonicalBody.repeat_reason,
      });
      return c.json(message);
    } catch (error) {
      const authMapped = mapDispatchPrincipalAuthError(c, error);
      if (authMapped) return authMapped;
      if (isBoardPrincipalAuthError(error)) return apiError(c, 401, (error as Error).message);
      if (
        error instanceof Error &&
        (error.message === 'board_motion_notifier_required' ||
          error.message === 'board_petition_principal_required')
      ) {
        return apiError(c, 403, error.message);
      }
      if (error instanceof Error && error.message.startsWith('dispatch_json_body_invalid')) {
        return apiError(c, 400, error.message);
      }
      if (error instanceof Error && error.message.startsWith('dispatch_recipient_rejected:')) {
        return apiError(c, 400, error.message);
      }
      if (error instanceof Error && error.message === 'repeat_reason_required') {
        return apiError(c, 409, error.message);
      }
      if (error instanceof Error && error.message.includes('invalid')) {
        return apiError(c, 400, error.message);
      }
      getLog().error({ err: error }, 'dispatch_create_message_failed');
      return apiError(c, 500, 'Failed to create dispatch message');
    }
  });

  registerOpenApiRoute(listDispatchMessagesRoute, async c => {
    try {
      const rawLimit = Number.parseInt(c.req.query('limit') ?? '100', 10);
      const messages = await dispatchDb.listMessages({
        recipient: c.req.query('recipient') ?? undefined,
        status: c.req.query('status') as dispatchDb.DispatchMessageStatus | undefined,
        subject_key: c.req.query('subject_key') ?? undefined,
        limit: Number.isFinite(rawLimit) ? rawLimit : 100,
        allowBoardAlias:
          c.req.query('recipient') !== undefined &&
          c.req.query('status') === 'queued' &&
          authenticateDispatchWorkerCredential({
            credential_id: c.req.header('x-dispatch-worker-credential-id'),
            token: c.req.header('x-dispatch-worker-token'),
            worker_id: c.req.header('x-dispatch-worker-id') ?? '',
            delivery_principal: c.req.query('recipient') ?? undefined,
          }) !== null,
      });
      return c.json(messages);
    } catch (error) {
      if (error instanceof Error && error.message === 'worker_unauthorized') {
        const rawLimit = Number.parseInt(c.req.query('limit') ?? '100', 10);
        const messages = await dispatchDb.listMessages({
          recipient: c.req.query('recipient') ?? undefined,
          status: c.req.query('status') as dispatchDb.DispatchMessageStatus | undefined,
          subject_key: c.req.query('subject_key') ?? undefined,
          limit: Number.isFinite(rawLimit) ? rawLimit : 100,
          allowBoardAlias: false,
        });
        return c.json(messages);
      }
      getLog().error({ err: error }, 'dispatch_list_messages_failed');
      return apiError(c, 500, 'Failed to list dispatch messages');
    }
  });

  registerOpenApiRoute(claimDispatchMessageRoute, async c => {
    try {
      const body = getValidatedBody(c, claimDispatchMessageBodySchema);
      if (body.delivery_principal) {
        authenticateDispatchWorkerCredential({
          credential_id: c.req.header('x-dispatch-worker-credential-id'),
          token: c.req.header('x-dispatch-worker-token'),
          worker_id: body.worker_id,
          delivery_principal: body.delivery_principal,
        });
      }
      const message = await dispatchDb.claimMessage({
        id: c.req.param('id') ?? '',
        worker_id: body.worker_id,
        delivery_principal: body.delivery_principal ?? null,
        leaseDurationMs: body.lease_duration_ms,
      });
      if (!message) return apiError(c, 404, 'Dispatch message is not claimable');
      return c.json(message);
    } catch (error) {
      if (error instanceof Error && error.message === 'worker_unauthorized') {
        return apiError(c, 401, 'worker_unauthorized');
      }
      getLog().error({ err: error }, 'dispatch_claim_message_failed');
      return apiError(c, 500, 'Failed to claim dispatch message');
    }
  });

  registerOpenApiRoute(acknowledgeDispatchMessageRoute, async c => {
    try {
      const body = getValidatedBody(c, dispatchMailboxPrincipalBodySchema);
      const result = await dispatchDb.acknowledgeMessage({
        id: c.req.param('id') ?? '',
        principal_id: body.principal_id,
      });
      if (!result.ok) {
        return apiError(c, result.reason === 'not_found' ? 404 : 409, result.reason);
      }
      return c.json(result.message);
    } catch (error) {
      getLog().error({ err: error }, 'dispatch_acknowledge_message_failed');
      return apiError(c, 500, 'Failed to acknowledge dispatch message');
    }
  });

  registerOpenApiRoute(addressDispatchMessageRoute, async c => {
    try {
      const body = getValidatedBody(c, dispatchMailboxPrincipalBodySchema);
      const result = await dispatchDb.addressMessage({
        id: c.req.param('id') ?? '',
        principal_id: body.principal_id,
      });
      if (!result.ok) {
        return apiError(c, result.reason === 'not_found' ? 404 : 409, result.reason);
      }
      return c.json(result.message);
    } catch (error) {
      getLog().error({ err: error }, 'dispatch_address_message_failed');
      return apiError(c, 500, 'Failed to address dispatch message');
    }
  });

  registerOpenApiRoute(postDispatchResultRoute, async c => {
    try {
      const body = getValidatedBody(c, postDispatchResultBodySchema);
      const message = await dispatchDb.postResult({
        id: c.req.param('id') ?? '',
        worker_id: body.worker_id,
        fencing_token: body.fencing_token,
        result_body: body.result_body,
        status: body.status,
        task_outcome: body.task_outcome,
      });
      if (!message) return apiError(c, 409, 'Stale fencing token or cancelled dispatch message');
      return c.json(message);
    } catch (error) {
      getLog().error({ err: error }, 'dispatch_post_result_failed');
      return apiError(c, 500, 'Failed to post dispatch result');
    }
  });

  registerOpenApiRoute(renewDispatchLeaseRoute, async c => {
    try {
      const body = getValidatedBody(c, renewDispatchLeaseBodySchema);
      const message = await dispatchDb.renewMessageLease({
        id: c.req.param('id') ?? '',
        worker_id: body.worker_id,
        fencing_token: body.fencing_token,
        ...(body.lease_duration_ms !== undefined
          ? { leaseDurationMs: body.lease_duration_ms }
          : {}),
      });
      if (!message) {
        return apiError(c, 409, 'Stale fencing token, not lease owner, or message not claimed');
      }
      return c.json(message);
    } catch (error) {
      getLog().error({ err: error }, 'dispatch_renew_lease_failed');
      return apiError(c, 500, 'Failed to renew dispatch lease');
    }
  });

  registerOpenApiRoute(cancelDispatchMessageRoute, async c => {
    try {
      const body = getValidatedBody(c, dispatchSenderBodySchema);
      const result = await dispatchDb.cancelMessage({
        id: c.req.param('id') ?? '',
        sender: body.sender,
      });
      if (!result.ok) return apiError(c, result.reason === 'not_found' ? 404 : 409, result.reason);
      return c.json(result.message);
    } catch (error) {
      getLog().error({ err: error }, 'dispatch_cancel_message_failed');
      return apiError(c, 500, 'Failed to cancel dispatch message');
    }
  });

  registerOpenApiRoute(supersedeDispatchMessageRoute, async c => {
    try {
      const body = getValidatedBody(c, supersedeDispatchMessageBodySchema);
      const { context } = resolveDispatchHttpSenderContext(c, body.sender);
      const result = await dispatchDb.supersedeMessage({
        id: c.req.param('id') ?? '',
        sender_context: context,
        replacement: {
          correlation_id: body.replacement.correlation_id,
          idempotency_key: body.replacement.idempotency_key,
          task_type: body.replacement.task_type,
          recipient: body.replacement.recipient,
          body: body.replacement.body,
          not_before: body.replacement.not_before ?? null,
          priority: body.replacement.priority,
          subject_key: body.replacement.subject_key,
          repeat_reason: body.replacement.repeat_reason,
        },
      });
      if (!result.ok) return apiError(c, result.reason === 'not_found' ? 404 : 409, result.reason);
      return c.json(result.message);
    } catch (error) {
      const authMapped = mapDispatchPrincipalAuthError(c, error);
      if (authMapped) return authMapped;
      if (error instanceof Error && error.message === 'dispatch_supersede_lost_race')
        return apiError(c, 409, 'not_queued');
      getLog().error({ err: error }, 'dispatch_supersede_message_failed');
      return apiError(c, 500, 'Failed to supersede dispatch message');
    }
  });

  registerOpenApiRoute(registerDispatchWorkerRoute, async c => {
    try {
      const body = getValidatedBody(c, registerDispatchWorkerBodySchema);
      const worker = await dispatchDb.registerWorker(body);
      return c.json(worker);
    } catch (error) {
      getLog().error({ err: error }, 'dispatch_register_worker_failed');
      return apiError(c, 500, 'Failed to register dispatch worker');
    }
  });

  registerOpenApiRoute(heartbeatDispatchWorkerRoute, async c => {
    try {
      const body = getValidatedBody(c, heartbeatDispatchWorkerBodySchema);
      const worker = await dispatchDb.heartbeatWorker(body);
      if (!worker) return apiError(c, 404, 'Dispatch worker not found');
      return c.json(worker);
    } catch (error) {
      getLog().error({ err: error }, 'dispatch_heartbeat_worker_failed');
      return apiError(c, 500, 'Failed to heartbeat dispatch worker');
    }
  });

  registerOpenApiRoute(getDispatchStatusRoute, async c => {
    try {
      const rawStaleAfterMs = Number.parseInt(
        c.req.query('worker_stale_after_ms') ?? String(dispatchDb.DEFAULT_WORKER_STALE_AFTER_MS),
        10
      );
      const staleAfterMs = Number.isFinite(rawStaleAfterMs)
        ? Math.max(1, Math.min(rawStaleAfterMs, 86_400_000))
        : dispatchDb.DEFAULT_WORKER_STALE_AFTER_MS;
      const [workers, messages] = await Promise.all([
        dispatchDb.listWorkers(staleAfterMs),
        dispatchDb.listMessages({ limit: 500 }),
      ]);
      const queue: Record<dispatchDb.DispatchMessageStatus, number> = {
        queued: 0,
        claimed: 0,
        done: 0,
        failed: 0,
        cancelled: 0,
      };
      for (const message of messages) queue[message.status] += 1;
      const item = (
        message: dispatchDb.DispatchMessage
      ): {
        id: string;
        sender: string;
        recipient: string;
        status: dispatchDb.DispatchMessageStatus;
        created_at: string;
        body_preview: string;
        result_preview: string | null;
      } => ({
        id: message.id,
        sender: message.sender,
        recipient: message.recipient,
        status: message.status,
        created_at: message.created_at,
        body_preview: message.body.slice(0, 240),
        result_preview: message.result_body?.slice(0, 240) ?? null,
      });
      const isExecutionHandoff = (message: dispatchDb.DispatchMessage): boolean => {
        if (message.task_type !== 'run_report') return false;
        try {
          return (
            (JSON.parse(message.body) as { kind?: string }).kind === 'approved_execution_handoff'
          );
        } catch {
          return false;
        }
      };
      return c.json({
        generated_at: new Date().toISOString(),
        worker_stale_after_ms: staleAfterMs,
        workers,
        queue,
        operator_reports: messages
          .filter(message => message.task_type === 'run_report' && !isExecutionHandoff(message))
          .map(item),
        execution_handoffs: messages.filter(isExecutionHandoff).map(item),
      });
    } catch (error) {
      getLog().error({ err: error }, 'dispatch_status_failed');
      return apiError(c, 500, 'Failed to get dispatch status');
    }
  });

  registerOpenApiRoute(createExecutionHandoffRoute, async c => {
    try {
      const body = getValidatedBody(c, executionHandoffBodySchema);
      const principalId = c.req.header('x-dispatch-principal-id');
      const principalToken = c.req.header('x-dispatch-principal-token');
      const capability = DispatchNonSystemCapability.fromAuthenticatedRequest({
        principal_id: principalId,
        token: principalToken,
        requested_sender: 'xo',
      });
      const message = await dispatchDb.createAuthenticatedMessage(capability, {
        correlation_id: body.correlation_id,
        idempotency_key: body.idempotency_key,
        task_type: 'run_report',
        recipient: body.target,
        body: JSON.stringify({ kind: 'approved_execution_handoff', ...body }),
      });
      return c.json(message);
    } catch (error) {
      const authMapped = mapDispatchPrincipalAuthError(c, error);
      if (authMapped) return authMapped;
      if (error instanceof Error && error.message.includes('invalid')) {
        return apiError(c, 400, error.message);
      }
      getLog().error({ err: error }, 'dispatch_execution_handoff_failed');
      return apiError(c, 500, 'Failed to create execution handoff');
    }
  });

  // =========================================================================
  // Board authority endpoints
  // =========================================================================

  registerOpenApiRoute(acquireXoLeaseRoute, async c => {
    try {
      const body = getValidatedBody(c, xoLeaseAcquireBodySchema);
      const principal = await boardAuthorityDb.authenticateBoardPrincipal(body);
      const result = await boardAuthorityDb.acquireXoLease({
        principal,
        holder_id: body.holder_id,
        holder_token: body.holder_token,
        lease_duration_ms: body.lease_duration_ms,
      });
      if (!result.ok || !result.lease) {
        return apiError(c, 409, result.reason ?? 'xo_lease_conflict');
      }
      return c.json(result.lease);
    } catch (error) {
      if (isBoardPrincipalAuthError(error)) return apiError(c, 401, (error as Error).message);
      getLog().error({ err: error }, 'board_xo_lease_acquire_failed');
      return apiError(c, 500, 'Failed to acquire XO lease');
    }
  });

  registerOpenApiRoute(renewXoLeaseRoute, async c => {
    try {
      const body = getValidatedBody(c, xoLeaseRenewBodySchema);
      const principal = await boardAuthorityDb.authenticateBoardPrincipal(body);
      const result = await boardAuthorityDb.renewXoLease({
        principal,
        holder_id: body.holder_id,
        holder_token: body.holder_token,
        fencing_token: body.fencing_token,
        lease_duration_ms: body.lease_duration_ms,
      });
      if (!result.ok || !result.lease) {
        return apiError(c, 409, result.reason ?? 'stale_xo_lease_token');
      }
      return c.json(result.lease);
    } catch (error) {
      if (isBoardPrincipalAuthError(error)) return apiError(c, 401, (error as Error).message);
      getLog().error({ err: error }, 'board_xo_lease_renew_failed');
      return apiError(c, 500, 'Failed to renew XO lease');
    }
  });

  registerOpenApiRoute(releaseXoLeaseRoute, async c => {
    try {
      const body = getValidatedBody(c, xoLeaseReleaseBodySchema);
      const principal = await boardAuthorityDb.authenticateBoardPrincipal(body);
      const result = await boardAuthorityDb.releaseXoLease({
        principal,
        holder_id: body.holder_id,
        holder_token: body.holder_token,
        fencing_token: body.fencing_token,
      });
      if (!result.ok || !result.lease) {
        return apiError(c, 409, result.reason ?? 'stale_xo_lease_token');
      }
      return c.json(result.lease);
    } catch (error) {
      if (isBoardPrincipalAuthError(error)) return apiError(c, 401, (error as Error).message);
      getLog().error({ err: error }, 'board_xo_lease_release_failed');
      return apiError(c, 500, 'Failed to release XO lease');
    }
  });

  registerOpenApiRoute(currentXoLeaseRoute, async c => {
    try {
      return c.json(await boardAuthorityDb.getCurrentXoLease());
    } catch (error) {
      getLog().error({ err: error }, 'board_xo_lease_current_failed');
      return apiError(c, 500, 'Failed to read current XO lease');
    }
  });

  registerOpenApiRoute(boardRecipientRoute, async c => {
    try {
      return c.json(await boardAuthorityDb.resolveBoardRecipient());
    } catch (error) {
      getLog().error({ err: error }, 'board_recipient_resolve_failed');
      return apiError(c, 500, 'Failed to resolve board recipient');
    }
  });

  // =======================================================================
  // Execution claim handlers (M-27B)
  // =======================================================================

  const executionClaimStatusByCode: Record<
    executionClaimsDb.ClaimFailureCode,
    400 | 401 | 404 | 409
  > = {
    validation_failed: 400,
    authority_rejected: 401,
    claim_conflict: 409,
    stale_fence: 409,
    reconciliation_required: 409,
    effect_attempt_mismatch: 409,
    not_found: 404,
  };

  function claimError(
    c: Context,
    code: executionClaimsDb.ClaimFailureCode,
    message: string
  ): Response {
    return c.json({ error: { code, message } }, executionClaimStatusByCode[code]);
  }

  function requireHolderToken(c: Context): string | null {
    return c.req.header('x-xo-holder-token')?.trim() || null;
  }

  registerOpenApiRoute(acquireExecutionClaimRoute, async c => {
    try {
      const body = getValidatedBody(c, acquireExecutionClaimBodySchema);
      const principal = await boardAuthorityDb.authenticateBoardPrincipal(
        boardPrincipalProofFromHeaders(c)
      );
      const holderToken = requireHolderToken(c);
      if (!holderToken) return claimError(c, 'authority_rejected', 'missing_holder_token');
      const result = await executionClaimsDb.acquireExecutionClaim({
        motion_id: body.motion_id,
        action_kind: body.action_kind,
        environment: body.environment,
        target_sha: body.target_sha,
        motion_file_path: body.motion_file_path,
        xo_holder_id: body.xo_holder_id,
        xo_lease_id: body.xo_lease_id,
        xo_fencing_token: body.xo_fencing_token,
        xo_holder_token: holderToken,
        lease_duration_ms: body.lease_duration_ms,
        initiator_principal_id: principal.principal_id,
        initiator_seat_id: principal.seat_id,
      });
      if (!result.ok) return claimError(c, result.code, result.message);
      return c.json(
        { claim: result.claim, created: result.created, outcome: result.outcome },
        result.created ? 201 : 200
      );
    } catch (error) {
      if (isBoardPrincipalAuthError(error)) return apiError(c, 401, (error as Error).message);
      getLog().error({ err: error }, 'execution_claim_acquire_failed');
      return apiError(c, 500, 'Failed to acquire execution claim');
    }
  });

  registerOpenApiRoute(renewExecutionClaimRoute, async c => {
    try {
      const body = getValidatedBody(c, renewExecutionClaimBodySchema);
      await boardAuthorityDb.authenticateBoardPrincipal(boardPrincipalProofFromHeaders(c));
      const holderToken = requireHolderToken(c);
      if (!holderToken) return claimError(c, 'authority_rejected', 'missing_holder_token');
      const result = await executionClaimsDb.renewExecutionClaim({
        claim_id: c.req.param('claim_id') ?? '',
        execution_fencing_token: body.execution_fencing_token,
        xo_holder_id: body.xo_holder_id,
        xo_lease_id: body.xo_lease_id,
        xo_fencing_token: body.xo_fencing_token,
        xo_holder_token: holderToken,
        lease_duration_ms: body.lease_duration_ms,
      });
      if (!result.ok) return claimError(c, result.code, result.message);
      return c.json({ claim: result.claim, renewed: true as const });
    } catch (error) {
      if (isBoardPrincipalAuthError(error)) return apiError(c, 401, (error as Error).message);
      getLog().error({ err: error }, 'execution_claim_renew_failed');
      return apiError(c, 500, 'Failed to renew execution claim');
    }
  });

  registerOpenApiRoute(preEffectExecutionClaimRoute, async c => {
    try {
      const body = getValidatedBody(c, executionFenceBodySchema);
      await boardAuthorityDb.authenticateBoardPrincipal(boardPrincipalProofFromHeaders(c));
      const holderToken = requireHolderToken(c);
      if (!holderToken) return claimError(c, 'authority_rejected', 'missing_holder_token');
      const result = await executionClaimsDb.validateExecutionFence({
        claim_id: c.req.param('claim_id') ?? '',
        execution_fencing_token: body.execution_fencing_token,
        xo_holder_id: body.xo_holder_id,
        xo_lease_id: body.xo_lease_id,
        xo_fencing_token: body.xo_fencing_token,
        xo_holder_token: holderToken,
      });
      if (!result.ok) return claimError(c, result.code, result.message);
      return c.json({
        claim_id: result.claim_id,
        permitted: true as const,
        effect_attempt_id: result.effect_attempt_id,
        execution_fencing_token: result.execution_fencing_token,
        motion_revision_sha: result.motion_revision_sha,
      });
    } catch (error) {
      if (isBoardPrincipalAuthError(error)) return apiError(c, 401, (error as Error).message);
      getLog().error({ err: error }, 'execution_claim_pre_effect_failed');
      return apiError(c, 500, 'Failed to validate execution fence');
    }
  });

  registerOpenApiRoute(reconciliationRequiredExecutionClaimRoute, async c => {
    try {
      const body = getValidatedBody(c, reconciliationRequiredBodySchema);
      await boardAuthorityDb.authenticateBoardPrincipal(boardPrincipalProofFromHeaders(c));
      const holderToken = requireHolderToken(c);
      if (!holderToken) return claimError(c, 'authority_rejected', 'missing_holder_token');
      const result = await executionClaimsDb.markExecutionReconciliationRequired({
        claim_id: c.req.param('claim_id') ?? '',
        execution_fencing_token: body.execution_fencing_token,
        xo_holder_id: body.xo_holder_id,
        xo_lease_id: body.xo_lease_id,
        xo_fencing_token: body.xo_fencing_token,
        xo_holder_token: holderToken,
        effect_attempt_id: body.effect_attempt_id,
        uncertainty: body.uncertainty,
      });
      if (!result.ok) return claimError(c, result.code, result.message);
      return c.json({ claim: result.claim, reconciliation_required: true as const });
    } catch (error) {
      if (isBoardPrincipalAuthError(error)) return apiError(c, 401, (error as Error).message);
      getLog().error({ err: error }, 'execution_claim_reconciliation_required_failed');
      return apiError(c, 500, 'Failed to record reconciliation requirement');
    }
  });

  registerOpenApiRoute(reconcileExecutionClaimRoute, async c => {
    try {
      const body = getValidatedBody(c, reconcileExecutionClaimBodySchema);
      await boardAuthorityDb.authenticateBoardPrincipal(boardPrincipalProofFromHeaders(c));
      const holderToken = requireHolderToken(c);
      if (!holderToken) return claimError(c, 'authority_rejected', 'missing_holder_token');
      const result = await executionClaimsDb.resolveExecutionReconciliation({
        claim_id: c.req.param('claim_id') ?? '',
        execution_fencing_token: body.execution_fencing_token,
        xo_holder_id: body.xo_holder_id,
        xo_lease_id: body.xo_lease_id,
        xo_fencing_token: body.xo_fencing_token,
        xo_holder_token: holderToken,
        effect_attempt_id: body.effect_attempt_id,
        resolution: body.resolution,
        evidence: body.evidence,
        external_effect_reference: body.external_effect_reference ?? null,
      });
      if (!result.ok) return claimError(c, result.code, result.message);
      return c.json({ claim: result.claim, resolution: body.resolution });
    } catch (error) {
      if (isBoardPrincipalAuthError(error)) return apiError(c, 401, (error as Error).message);
      getLog().error({ err: error }, 'execution_claim_reconcile_failed');
      return apiError(c, 500, 'Failed to resolve execution reconciliation');
    }
  });

  registerOpenApiRoute(releaseExecutionClaimRoute, async c => {
    try {
      const body = getValidatedBody(c, executionFenceBodySchema);
      await boardAuthorityDb.authenticateBoardPrincipal(boardPrincipalProofFromHeaders(c));
      const holderToken = requireHolderToken(c);
      if (!holderToken) return claimError(c, 'authority_rejected', 'missing_holder_token');
      const result = await executionClaimsDb.releaseExecutionClaim({
        claim_id: c.req.param('claim_id') ?? '',
        execution_fencing_token: body.execution_fencing_token,
        xo_holder_id: body.xo_holder_id,
        xo_lease_id: body.xo_lease_id,
        xo_fencing_token: body.xo_fencing_token,
        xo_holder_token: holderToken,
      });
      if (!result.ok) return claimError(c, result.code, result.message);
      return c.json({ claim: result.claim, released: true as const });
    } catch (error) {
      if (isBoardPrincipalAuthError(error)) return apiError(c, 401, (error as Error).message);
      getLog().error({ err: error }, 'execution_claim_release_failed');
      return apiError(c, 500, 'Failed to release execution claim');
    }
  });

  registerOpenApiRoute(completeExecutionClaimRoute, async c => {
    try {
      const body = getValidatedBody(c, completeExecutionClaimBodySchema);
      await boardAuthorityDb.authenticateBoardPrincipal(boardPrincipalProofFromHeaders(c));
      const holderToken = requireHolderToken(c);
      if (!holderToken) return claimError(c, 'authority_rejected', 'missing_holder_token');
      const result = await executionClaimsDb.completeExecutionClaim({
        claim_id: c.req.param('claim_id') ?? '',
        execution_fencing_token: body.execution_fencing_token,
        xo_holder_id: body.xo_holder_id,
        xo_lease_id: body.xo_lease_id,
        xo_fencing_token: body.xo_fencing_token,
        xo_holder_token: holderToken,
        effect_attempt_id: body.effect_attempt_id,
        external_effect_reference: body.external_effect_reference,
        evidence: body.evidence,
      });
      if (!result.ok) return claimError(c, result.code, result.message);
      return c.json({ claim: result.claim, completed: true as const });
    } catch (error) {
      if (isBoardPrincipalAuthError(error)) return apiError(c, 401, (error as Error).message);
      getLog().error({ err: error }, 'execution_claim_complete_failed');
      return apiError(c, 500, 'Failed to complete execution claim');
    }
  });

  registerOpenApiRoute(getExecutionClaimRoute, async c => {
    try {
      const claim = await executionClaimsDb.getExecutionClaim({
        motion_id: c.req.query('motion_id') ?? '',
        action_kind: c.req.query('action_kind') ?? '',
        environment: c.req.query('environment') ?? '',
        target_sha: c.req.query('target_sha') ?? '',
      });
      if (!claim) return claimError(c, 'not_found', 'claim_not_found');
      return c.json({ claim });
    } catch (error) {
      getLog().error({ err: error }, 'execution_claim_get_failed');
      return apiError(c, 500, 'Failed to read execution claim');
    }
  });

  // =========================================================================
  // M-31 Overseer merge-steward substrate handlers (M-42 Slice 2).
  // All typed failures fail closed with HTTP 409; the capability gate denies
  // with 403. No provider mutation is reachable from any handler below.
  // =========================================================================

  function m31FailureResponse(c: Context, failure: mergeStewardDb.M31TypedFailure): Response {
    return c.json({ error: { failure, message: failure } }, 409);
  }

  registerOpenApiRoute(registerM31SnapshotRoute, async c => {
    try {
      const body = getValidatedBody(c, registerM31SnapshotBodySchema);
      await boardAuthorityDb.authenticateBoardPrincipal(boardPrincipalProofFromHeaders(c));
      const snapshot = await mergeStewardDb.registerM31Snapshot({
        snapshot_id: body.snapshot_id,
        repository: body.repository,
        capture_started_at: body.capture_started_at,
        capture_completed_at: body.capture_completed_at,
        operator_actor: body.operator_actor,
        operator_model: body.operator_model,
        read_only_query_method: body.read_only_query_method,
        base_branch: body.base_branch,
        base_sha: body.base_sha,
        predecessor_snapshot_id: body.predecessor_snapshot_id ?? null,
        predecessor_evidence_git_blob: body.predecessor_evidence_git_blob ?? null,
        artifact_path: body.artifact_path,
        git_object_format: body.git_object_format,
        evidence_git_blob: body.evidence_git_blob,
        mutation_attempted: body.mutation_attempted,
        fusion_calls_attempted: body.fusion_calls_attempted,
        members: body.members,
      });
      return c.json({ snapshot }, 201);
    } catch (error) {
      if (isBoardPrincipalAuthError(error)) return apiError(c, 401, (error as Error).message);
      getLog().error({ err: error }, 'm31_snapshot_register_failed');
      return apiError(c, 500, 'Failed to register M-31 snapshot');
    }
  });

  registerOpenApiRoute(getM31SnapshotRoute, async c => {
    try {
      await boardAuthorityDb.authenticateBoardPrincipal(boardPrincipalProofFromHeaders(c));
      const snapshot = await mergeStewardDb.getM31Snapshot(c.req.param('snapshot_id') ?? '');
      if (!snapshot) return apiError(c, 404, 'M-31 snapshot not found');
      return c.json({ snapshot });
    } catch (error) {
      if (isBoardPrincipalAuthError(error)) return apiError(c, 401, (error as Error).message);
      getLog().error({ err: error }, 'm31_snapshot_get_failed');
      return apiError(c, 500, 'Failed to read M-31 snapshot');
    }
  });

  registerOpenApiRoute(appendM31DiscrepancyRoute, async c => {
    try {
      const body = getValidatedBody(c, appendM31DiscrepancyBodySchema);
      await boardAuthorityDb.authenticateBoardPrincipal(boardPrincipalProofFromHeaders(c));
      const discrepancy = await mergeStewardDb.appendM31Discrepancy({
        snapshot_id: c.req.param('snapshot_id') ?? '',
        evidence_git_blob: body.evidence_git_blob,
        affected_rows: body.affected_rows,
        observed_conflict: body.observed_conflict,
        recorder: body.recorder,
        resolution: body.resolution ?? null,
        predecessor_discrepancy_id: body.predecessor_discrepancy_id ?? null,
      });
      return c.json({ discrepancy }, 201);
    } catch (error) {
      if (isBoardPrincipalAuthError(error)) return apiError(c, 401, (error as Error).message);
      getLog().error({ err: error }, 'm31_discrepancy_append_failed');
      return apiError(c, 500, 'Failed to append M-31 discrepancy');
    }
  });

  registerOpenApiRoute(createM31ProposalRoute, async c => {
    try {
      const body = getValidatedBody(c, createM31ProposalBodySchema);
      await boardAuthorityDb.authenticateBoardPrincipal(boardPrincipalProofFromHeaders(c));
      const result = await mergeStewardDb.createM31ActionProposal({
        proposal_id: body.proposal_id,
        repository: body.repository,
        pr_number: body.pr_number,
        head_sha: body.head_sha,
        base_branch: body.base_branch,
        base_sha: body.base_sha,
        snapshot_id: body.snapshot_id,
        evidence_path: body.evidence_path,
        action_kind: body.action_kind,
        action_parameters: body.action_parameters,
        actor: body.actor,
        policy_digest: body.policy_digest,
        verifier_registry_digest: body.verifier_registry_digest,
        ttl_ms: body.ttl_ms,
        max_evidence_age_ms: body.max_evidence_age_ms,
      });
      if (!result.ok) return m31FailureResponse(c, result.failure);
      return c.json({ proposal: result.value }, 201);
    } catch (error) {
      if (isBoardPrincipalAuthError(error)) return apiError(c, 401, (error as Error).message);
      getLog().error({ err: error }, 'm31_proposal_create_failed');
      return apiError(c, 500, 'Failed to create M-31 proposal');
    }
  });

  registerOpenApiRoute(getM31ProposalRoute, async c => {
    try {
      await boardAuthorityDb.authenticateBoardPrincipal(boardPrincipalProofFromHeaders(c));
      const proposal = await mergeStewardDb.getM31ActionProposal(c.req.param('proposal_id') ?? '');
      if (!proposal) return apiError(c, 404, 'M-31 proposal not found');
      return c.json({ proposal });
    } catch (error) {
      if (isBoardPrincipalAuthError(error)) return apiError(c, 401, (error as Error).message);
      getLog().error({ err: error }, 'm31_proposal_get_failed');
      return apiError(c, 500, 'Failed to read M-31 proposal');
    }
  });

  registerOpenApiRoute(compareAndConsumeM31ProposalRoute, async c => {
    try {
      const body = getValidatedBody(c, compareAndConsumeM31BodySchema);
      await boardAuthorityDb.authenticateBoardPrincipal(boardPrincipalProofFromHeaders(c));
      // The authenticated operator supplies the exact read-only live observation.
      // This slice reaches NO provider: the reader returns the submitted observation.
      const submittedObservation = body.observation;
      const reader: M31LiveStateReader = {
        readBoundState: async () => submittedObservation,
      };
      const result = await m31Substrate.prepareM31ActionPermit(
        {
          proposal_id: c.req.param('proposal_id') ?? '',
          validity_window_ms: body.validity_window_ms,
        },
        {
          liveStateReader: reader,
          capabilityGate: m31Substrate.createFailClosedM31CapabilityGate(),
        }
      );
      if (result.ok) return c.json({ permit: result.permit, receipt: result.receipt });
      if ('not_found' in result) return apiError(c, 404, 'M-31 proposal not found');
      if ('denied' in result) {
        return c.json(
          {
            error: {
              reason: 'gate_denied' as const,
              capability: result.denied.capability,
              message: result.denied.reason,
            },
          },
          403
        );
      }
      return m31FailureResponse(c, result.failure);
    } catch (error) {
      if (isBoardPrincipalAuthError(error)) return apiError(c, 401, (error as Error).message);
      if (error instanceof mergeStewardDb.M31ProposalNotFoundError) {
        return apiError(c, 404, 'M-31 proposal not found');
      }
      getLog().error({ err: error }, 'm31_compare_and_consume_failed');
      return apiError(c, 500, 'Failed to compare and consume M-31 proposal');
    }
  });

  registerOpenApiRoute(listOperatorCardsRoute, async c => {
    try {
      await boardAuthorityDb.authenticateBoardPrincipal(boardPrincipalProofFromHeaders(c));
      return c.json(
        await overseerBriefingDb.listOperatorCards({
          cursor: c.req.query('cursor') || undefined,
          limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
        })
      );
    } catch (error) {
      if (isBoardPrincipalAuthError(error)) return apiError(c, 401, (error as Error).message);
      getLog().error({ err: error }, 'operator_card_list_failed');
      return apiError(c, 500, 'Failed to list operator cards');
    }
  });

  registerOpenApiRoute(getOperatorCardRoute, async c => {
    try {
      await boardAuthorityDb.authenticateBoardPrincipal(boardPrincipalProofFromHeaders(c));
      const card = await overseerBriefingDb.getOperatorCard(c.req.param('card_id') ?? '');
      if (!card) return apiError(c, 404, 'Operator card not found');
      return c.json(card);
    } catch (error) {
      if (isBoardPrincipalAuthError(error)) return apiError(c, 401, (error as Error).message);
      getLog().error({ err: error }, 'operator_card_get_failed');
      return apiError(c, 500, 'Failed to read operator card');
    }
  });

  // GET /api/dashboard/provider-attempts -- read-only reliability feed.
  // Auth is covered by the global /api/* operator-token middleware above;
  // no per-route auth code needed. Returns raw rows; the cockpit aggregates.
  registerOpenApiRoute(listProviderAttemptsRoute, async c => {
    try {
      const since = c.req.query('since') || undefined;
      const limitRaw = c.req.query('limit');
      const limit = limitRaw ? Number(limitRaw) : undefined;
      const items = await workflowDb.listProviderAttemptsFeed({ since, limit });
      return c.json({ items });
    } catch (error) {
      getLog().error({ err: error }, 'provider_attempts_feed_failed');
      return apiError(c, 500, 'Failed to list provider attempts');
    }
  });

  // M-42 Slice 8: mount reviewed isolated M-31 target-v2 route module.
  // No provider mutation client is injected. Board principal auth required.
  registerM31TargetV2Routes(app, {
    authenticatePrincipal: async (request: Request) => {
      const token = request.headers.get('x-board-principal-token')?.trim();
      await boardAuthorityDb.authenticateBoardPrincipal({ principal_token: token });
    },
    registerSnapshot: input => m31TargetV2Db.registerM31SnapshotV2(input),
    getSnapshot: id => m31TargetV2Db.getM31SnapshotV2(id),
    appendDiscrepancy: input => m31TargetV2Db.appendM31DiscrepancyV2(input),
    resolveDiscrepancy: input => m31TargetV2Db.resolveM31DiscrepancyV2(input),
    createProposal: input => m31TargetV2Db.createM31ActionProposalV2(input),
    getProposal: id => m31TargetV2Db.getM31ActionProposalV2(id),
    preparePermit: async input =>
      m31TargetV2Db.compareAndConsumeM31ProposalV2({
        proposal_id: input.proposal_id,
        observation: input.observation,
        validity_window_ms: input.validity_window_ms,
      }),
  });

  // GET /api/stream/__dashboard__ -- multiplexed dashboard SSE (all workflow events)
  // IMPORTANT: Must be registered before /api/stream/:conversationId to avoid param capture.
  app.get('/api/stream/__dashboard__', async c => {
    return streamSSE(c, async stream => {
      await stream.writeSSE({
        data: JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }),
      });

      webAdapter.registerStream('__dashboard__', stream);
      getLog().debug({ streamId: '__dashboard__' }, 'dashboard_sse_opened');

      stream.onAbort(() => {
        getLog().debug({ streamId: '__dashboard__' }, 'dashboard_sse_disconnected');
        webAdapter.removeStream('__dashboard__', stream);
      });

      try {
        while (true) {
          await stream.sleep(30000);
          if (!stream.closed) {
            await stream.writeSSE({
              data: JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }),
            });
          }
        }
      } catch (e: unknown) {
        const msg = (e as Error).message ?? '';
        if (!msg.includes('aborted') && !msg.includes('closed') && !msg.includes('cancel')) {
          getLog().warn({ err: e as Error }, 'dashboard_sse_heartbeat_error');
        }
      } finally {
        webAdapter.removeStream('__dashboard__', stream);
        getLog().debug({ streamId: '__dashboard__' }, 'dashboard_sse_closed');
      }
    });
  });

  // GET /api/stream/:conversationId - SSE streaming
  app.get('/api/stream/:conversationId', async c => {
    const conversationId = c.req.param('conversationId');

    return streamSSE(c, async stream => {
      // Send initial heartbeat immediately to flush HTTP headers.
      // Without this, EventSource stays in CONNECTING state until the first write.
      await stream.writeSSE({
        data: JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }),
      });

      webAdapter.registerStream(conversationId, stream);
      getLog().debug({ conversationId }, 'sse_stream_opened');

      stream.onAbort(() => {
        getLog().debug({ conversationId }, 'sse_client_disconnected');
        webAdapter.removeStream(conversationId, stream);
      });

      try {
        while (true) {
          await stream.sleep(30000);
          if (!stream.closed) {
            await stream.writeSSE({
              data: JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }),
            });
          }
        }
      } catch (e: unknown) {
        // stream.sleep() throws when client disconnects -- expected behavior.
        // Log unexpected errors for debugging.
        const msg = (e as Error).message ?? '';
        if (!msg.includes('aborted') && !msg.includes('closed') && !msg.includes('cancel')) {
          getLog().warn({ err: e as Error, conversationId }, 'sse_heartbeat_error');
        }
      } finally {
        webAdapter.removeStream(conversationId, stream);
        getLog().debug({ conversationId }, 'sse_stream_closed');
      }
    });
  });

  // GET /api/codebases - List codebases
  registerOpenApiRoute(listCodebasesRoute, async c => {
    try {
      const codebases = await codebaseDb.listCodebases();

      // Deduplicate by repository_url (keep most recently updated)
      const normalizeUrl = (url: string): string => url.replace(/\.git$/, '');
      const seen = new Map<string, (typeof codebases)[number]>();
      const deduped: (typeof codebases)[number][] = [];
      for (const cb of codebases) {
        if (!cb.repository_url) {
          deduped.push(cb);
          continue;
        }
        const key = normalizeUrl(cb.repository_url);
        const existing = seen.get(key);
        if (!existing || cb.updated_at > existing.updated_at) {
          seen.set(key, cb);
        }
      }
      deduped.push(...seen.values());
      deduped.sort((a, b) => a.name.localeCompare(b.name));

      return c.json(
        deduped.map(cb => {
          let commands = cb.commands;
          if (typeof commands === 'string') {
            try {
              commands = JSON.parse(commands);
            } catch (parseErr) {
              getLog().error({ err: parseErr, codebaseId: cb.id }, 'corrupted_commands_json');
              commands = {};
            }
          }
          return { ...cb, commands };
        })
      );
    } catch (error) {
      getLog().error({ err: error }, 'list_codebases_failed');
      return apiError(c, 500, 'Failed to list codebases');
    }
  });

  // GET /api/codebases/:id - Codebase detail
  registerOpenApiRoute(getCodebaseRoute, async c => {
    try {
      const codebase = await codebaseDb.getCodebase(c.req.param('id') ?? '');
      if (!codebase) {
        return apiError(c, 404, 'Codebase not found');
      }
      let commands = codebase.commands;
      if (typeof commands === 'string') {
        try {
          commands = JSON.parse(commands);
        } catch (parseErr) {
          getLog().error({ err: parseErr, codebaseId: codebase.id }, 'corrupted_commands_json');
          commands = {};
        }
      }
      return c.json({ ...codebase, commands });
    } catch (error) {
      getLog().error({ err: error }, 'get_codebase_failed');
      return apiError(c, 500, 'Failed to get codebase');
    }
  });

  // POST /api/codebases - Add a project (clone from URL or register local path)
  registerOpenApiRoute(addCodebaseRoute, async c => {
    const body = getValidatedBody(c, addCodebaseBodySchema);

    try {
      // .refine() guarantees exactly one of url/path is present
      const result = body.url
        ? await cloneRepository(body.url)
        : await registerRepository(body.path ?? '');

      // Fetch the full codebase record for a consistent response
      const codebase = await codebaseDb.getCodebase(result.codebaseId);
      if (!codebase) {
        return apiError(c, 500, 'Codebase created but not found');
      }

      return c.json(codebase, result.alreadyExisted ? 200 : 201);
    } catch (error) {
      getLog().error({ err: error }, 'add_codebase_failed');
      return apiError(
        c,
        500,
        `Failed to add codebase: ${(error as Error).message ?? 'unknown error'}`
      );
    }
  });

  // DELETE /api/codebases/:id - Delete a project and clean up
  registerOpenApiRoute(deleteCodebaseRoute, async c => {
    const id = c.req.param('id') ?? '';
    try {
      const codebase = await codebaseDb.getCodebase(id);
      if (!codebase) {
        return apiError(c, 404, 'Codebase not found');
      }

      // Clean up isolation environments (worktrees)
      const environments = await isolationEnvDb.listByCodebase(id);
      for (const env of environments) {
        try {
          await removeWorktree(toRepoPath(codebase.default_cwd), toWorktreePath(env.working_path));
          getLog().info({ path: env.working_path }, 'worktree_removed');
        } catch (wtErr) {
          // Worktree may already be gone -- log but continue
          getLog().warn({ err: wtErr, path: env.working_path }, 'worktree_remove_failed');
        }
        await isolationEnvDb.updateStatus(env.id, 'destroyed');
      }

      // Delete from database (unlinks conversations and sessions)
      await codebaseDb.deleteCodebase(id);

      // Remove workspace directory from disk -- only for Archon-managed repos
      const workspacesRoot = normalize(getArchonWorkspacesPath());
      const normalizedCwd = normalize(codebase.default_cwd);
      if (
        normalizedCwd.startsWith(workspacesRoot + '/') ||
        normalizedCwd.startsWith(workspacesRoot + '\\')
      ) {
        try {
          await rm(normalizedCwd, { recursive: true, force: true });
          getLog().info({ path: normalizedCwd }, 'workspace_removed');
        } catch (rmErr) {
          // Directory may not exist -- log but don't fail
          getLog().warn({ err: rmErr, path: codebase.default_cwd }, 'workspace_remove_failed');
        }
      } else {
        getLog().info({ path: codebase.default_cwd }, 'external_repo_skip_deletion');
      }

      return c.json({ success: true });
    } catch (error) {
      getLog().error({ err: error }, 'delete_codebase_failed');
      return apiError(c, 500, 'Failed to delete codebase');
    }
  });

  // GET /api/codebases/:id/env - List env var keys for a codebase (values never returned)
  registerOpenApiRoute(listEnvVarsRoute, async c => {
    const id = c.req.param('id') ?? '';
    try {
      const codebase = await codebaseDb.getCodebase(id);
      if (!codebase) return apiError(c, 404, 'Codebase not found');
      const envVars = await envVarDb.getCodebaseEnvVars(id);
      return c.json({ keys: Object.keys(envVars) });
    } catch (error) {
      getLog().error({ err: error, codebaseId: id }, 'list_env_vars_failed');
      return apiError(c, 500, 'Failed to list env vars');
    }
  });

  // PUT /api/codebases/:id/env - Set (upsert) an env var
  registerOpenApiRoute(setEnvVarRoute, async c => {
    const id = c.req.param('id') ?? '';
    try {
      const body = getValidatedBody(c, setEnvVarBodySchema);
      const codebase = await codebaseDb.getCodebase(id);
      if (!codebase) return apiError(c, 404, 'Codebase not found');
      await envVarDb.setCodebaseEnvVar(id, body.key, body.value);
      return c.json({ success: true });
    } catch (error) {
      getLog().error({ err: error, codebaseId: id }, 'set_env_var_failed');
      return apiError(c, 500, 'Failed to set env var');
    }
  });

  // DELETE /api/codebases/:id/env/:key - Delete an env var
  registerOpenApiRoute(deleteEnvVarRoute, async c => {
    const id = c.req.param('id') ?? '';
    const key = c.req.param('key') ?? '';
    try {
      const codebase = await codebaseDb.getCodebase(id);
      if (!codebase) return apiError(c, 404, 'Codebase not found');
      await envVarDb.deleteCodebaseEnvVar(id, key);
      return c.json({ success: true });
    } catch (error) {
      getLog().error({ err: error, codebaseId: id, key }, 'delete_env_var_failed');
      return apiError(c, 500, 'Failed to delete env var');
    }
  });

  /**
   * Register a route with OpenAPI spec generation and input validation.
   * Zod validates inputs (query, params, body) at runtime via defaultHook.
   * Response schemas are used for OpenAPI spec generation only -- output is not
   * validated at runtime. The `as never` cast bypasses TypedResponse constraints.
   */
  function registerOpenApiRoute(
    route: ReturnType<typeof createRoute>,
    handler: (c: Context) => Response | Promise<Response>
  ): void {
    app.openapi(route, handler as never);
  }

  /**
   * Access Zod-validated body from a handler registered via registerOpenApiRoute.
   * Returns the schema OUTPUT type (post-parse), so `.default(...)` values are
   * typed non-optional -- the validator applies defaults at runtime before the
   * handler runs.
   */
  function getValidatedBody<T>(c: Context, _schema: z.ZodType<T, z.ZodTypeDef, unknown>): T {
    return (c.req as unknown as { valid(k: 'json'): T }).valid('json');
  }

  function getValidatedQuery<T>(c: Context, _schema: z.ZodType<T, z.ZodTypeDef, unknown>): T {
    return (c.req as unknown as { valid(k: 'query'): T }).valid('query');
  }

  // Serve OpenAPI spec
  app.doc('/api/openapi.json', {
    openapi: '3.0.0',
    info: { title: 'Archon API', version: '1.0.0' },
  });

  // =========================================================================
  // Workflow endpoints
  // =========================================================================

  // GET /api/public/workflows/runs - Portfolio-safe workflow run summary.
  app.get('/api/public/workflows/runs', async c => {
    try {
      const rawLimit = Number.parseInt(c.req.query('limit') ?? '20', 10);
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 50)) : 20;
      const runs = await workflowDb.listWorkflowRuns({ limit });
      const publicRuns = await Promise.all(runs.map(sanitizeWorkflowRunForPublic));
      return c.json({ runs: publicRuns });
    } catch (error) {
      getLog().error({ err: error }, 'public_workflow_runs_failed');
      return apiError(c, 500, 'Failed to list public workflow runs');
    }
  });

  // GET /api/workflows - Discover available workflows
  registerOpenApiRoute(getWorkflowsRoute, async c => {
    try {
      const cwd = c.req.query('cwd');
      let workingDir = cwd;

      // Validate caller-supplied cwd against registered codebase paths
      if (cwd) {
        if (!(await validateCwd(cwd))) {
          return apiError(c, 400, 'Invalid cwd: must match a registered codebase path');
        }
      } else {
        // Fallback to first codebase's default_cwd
        const codebases = await codebaseDb.listCodebases();
        if (codebases.length > 0) {
          workingDir = codebases[0].default_cwd;
        }
      }

      if (!workingDir) {
        return c.json({
          workflows: [],
          validation_errors: { count: 0, endpoint: '/api/workflows/errors' },
        });
      }

      const result = await discoverWorkflowsWithConfig(workingDir, loadConfig);
      const loaderErrors = getLoaderErrors();
      return c.json({
        workflows: result.workflows.map(ws => ({ workflow: ws.workflow, source: ws.source })),
        errors: result.errors.length > 0 ? result.errors : undefined,
        validation_errors: { count: loaderErrors.length, endpoint: '/api/workflows/errors' },
      });
    } catch (error) {
      // Workflow discovery can fail if cwd is stale or deleted -- return empty with warning
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err }, 'workflow_discovery_failed');
      return apiError(c, 500, `Workflow discovery failed: ${err.message}`);
    }
  });

  // GET /api/workflows/errors - Discover workflow loader errors
  registerOpenApiRoute(getWorkflowErrorsRoute, async c => {
    try {
      const cwd = c.req.query('cwd');
      let workingDir = cwd;

      if (cwd) {
        if (!(await validateCwd(cwd))) {
          return apiError(c, 400, 'Invalid cwd: must match a registered codebase path');
        }
      } else {
        const codebases = await codebaseDb.listCodebases();
        if (codebases.length > 0) {
          workingDir = codebases[0].default_cwd;
        }
      }

      if (!workingDir) {
        return c.json({ errors: [], count: 0 });
      }

      await discoverWorkflowsWithConfig(workingDir, loadConfig);
      const errors = getLoaderErrors();
      return c.json({ errors, count: errors.length });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err }, 'workflow_errors_discovery_failed');
      return apiError(c, 500, `Workflow error discovery failed: ${err.message}`);
    }
  });

  // POST /api/workflows/:name/run - Run a workflow via the orchestrator
  registerOpenApiRoute(runWorkflowRoute, async c => {
    const workflowName = c.req.param('name') ?? '';
    if (!isValidCommandName(workflowName)) {
      return apiError(c, 400, 'Invalid workflow name');
    }
    try {
      const drainRejection = await rejectNewDispatchIfDraining(c);
      if (drainRejection) return drainRejection;
      const { conversationId, message, conductor } = getValidatedBody(c, runWorkflowBodySchema);
      // Persist user message and register DB ID (same as message endpoint).
      // /run callers may provide a fresh platform conversation id; create that
      // row up front so workflow dispatch can attach a run and web persistence
      // has a DB id for status/output messages.
      let conv: Awaited<ReturnType<typeof conversationDb.findConversationByPlatformId>> = null;
      try {
        conv = await conversationDb.findConversationByPlatformId(conversationId);
      } catch (e: unknown) {
        getLog().error({ err: e, conversationId }, 'conversation_lookup_failed');
      }
      if (!conv) {
        conv = await conversationDb.getOrCreateConversation('web', conversationId);
      }
      if (conv) {
        try {
          await messageDb.addMessage(conv.id, 'user', message);
        } catch (e: unknown) {
          getLog().error({ err: e, conversationId: conv.id }, 'message_persistence_failed');
        }
        webAdapter.setConversationDbId(conversationId, conv.id);
        // Generate title for sidebar (fire-and-forget)
        if (!conv.title) {
          void generateAndSetTitle(
            conv.id,
            message,
            conv.ai_assistant_type,
            getArchonWorkspacesPath(),
            workflowName
          );
        }
      }

      if (
        conductor?.enabled === true &&
        process.env.ARCHON_SMART_CAULDRON_DISPATCH_ENABLED === 'true'
      ) {
        const cascadeOptions = {
          woId: conductor.woId,
          woClass: conductor.woClass,
          tags: conductor.tags,
          entryOverride: conductor.entryOverride,
          dispatchId: conductor.idempotencyKey,
          dryRun: conductor.dryRun ?? false,
          project: conductor.project,
          token: c.req.header('x-archon-operator-token') ?? process.env.ARCHON_OPERATOR_TOKEN ?? '',
        };
        if (cascadeOptions.dryRun) {
          const record = await runCascade(cascadeOptions);
          return c.json({
            accepted: true,
            status: record.status,
            dispatchMode: 'conductor' as const,
            cascadeId: record.cascadeId,
            entryTier: record.telemetry.entryTier,
          });
        }

        let resolveAdmission: ((record: Awaited<ReturnType<typeof runCascade>>) => void) | null =
          null;
        let rejectAdmission: ((error: unknown) => void) | null = null;
        const admission = new Promise<Awaited<ReturnType<typeof runCascade>>>((resolve, reject) => {
          resolveAdmission = resolve;
          rejectAdmission = reject;
        });
        const cascadePromise = runCascade({
          ...cascadeOptions,
          deps: {
            preflight: async tier => {
              const check = await validateWorkflowRunTarget(
                `/workflow run ${tier.workflowName}`,
                conv?.codebase_id
              );
              if (!check.valid) throw new Error(check.error);
            },
          },
          onAdmission: record => resolveAdmission?.(record),
        });
        void cascadePromise.catch((error: unknown) => {
          rejectAdmission?.(error);
          getLog().error(
            { err: error, cascadeId: conductor.idempotencyKey, woId: conductor.woId },
            'smart_cauldron_dispatch_failed'
          );
        });
        const admittedRecord = await admission;
        return c.json({
          accepted: true,
          status: admittedRecord.status === 'running' ? 'queued' : admittedRecord.status,
          dispatchMode: 'conductor' as const,
          cascadeId: admittedRecord.cascadeId,
        });
      }

      const fullMessage = `/workflow run ${workflowName} ${message}`;
      const check = await validateWorkflowRunTarget(fullMessage, conv?.codebase_id);
      if (!check.valid) {
        if (check.httpStatus === 503 && check.error === 'codex_auth_stale') {
          void postBuilderStatusAlert(
            'blocked',
            'codex auth stale -- dispatch refused',
            conductor?.woId
          );
          return c.json({ error: 'codex_auth_stale' }, 503);
        }
        return c.json({ accepted: false, error: check.error }, 400);
      }

      // Duplicate-fire guard (bdc-xo#1546): refuse a NEW independent fire while
      // another run for the same WO is still live. Cascade climbs carry prior-
      // attempt context and only fire after the prior run is terminal.
      const allowConcurrent =
        c.req.header('x-archon-allow-concurrent') === '1' ||
        c.req.header('x-archon-allow-concurrent') === 'true';
      if (!allowConcurrent && !isCascadeClimbMessage(message)) {
        const woId = conductor?.woId ?? extractWoIdFromMessage(message);
        if (woId) {
          const live = await findLiveRunsForWo(woId);
          if (live.length > 0) {
            getLog().warn(
              { woId, liveRunIds: live.map(r => r.id), workflowName },
              'wo_duplicate_fire_refused'
            );
            return c.json(
              {
                accepted: false,
                error: 'duplicate_wo_live',
                woId,
                liveRuns: live,
                hint: 'Cancel the live run or pass x-archon-allow-concurrent: 1 if you own the race',
              },
              409
            );
          }
        }
      }

      const result = await dispatchToOrchestrator(conversationId, fullMessage);
      return c.json(result);
    } catch (error) {
      getLog().error({ err: error }, 'run_workflow_failed');
      return apiError(c, 500, 'Failed to run workflow');
    }
  });

  // GET /api/dashboard/runs - Enriched workflow runs for Command Center
  // Supports server-side search, status/date filtering, and offset pagination.
  registerOpenApiRoute(getDashboardRunsRoute, async c => {
    try {
      const rawStatus = c.req.query('status');
      const dashboardValidStatuses = [
        'pending',
        'running',
        'waiting_provider',
        'interrupted',
        'completed',
        'failed',
        'cancelled',
        'paused',
      ] as const;
      type DashboardRunStatus = (typeof dashboardValidStatuses)[number];
      const status: DashboardRunStatus | undefined =
        rawStatus && (dashboardValidStatuses as readonly string[]).includes(rawStatus)
          ? (rawStatus as DashboardRunStatus)
          : undefined;
      const codebaseId = c.req.query('codebaseId') ?? undefined;
      const search = c.req.query('search')?.trim() || undefined;
      const after = c.req.query('after') ?? undefined;
      const before = c.req.query('before') ?? undefined;
      const limitRaw = Number(c.req.query('limit'));
      const limit = Number.isNaN(limitRaw) ? 50 : Math.min(Math.max(1, limitRaw), 200);
      const offsetRaw = Number(c.req.query('offset'));
      const offset = Number.isNaN(offsetRaw) ? 0 : Math.max(0, offsetRaw);

      const includeArchived = c.req.query('includeArchived') === 'true';

      const result = await workflowDb.listDashboardRuns({
        status,
        codebaseId,
        search,
        after,
        before,
        limit,
        offset,
        includeArchived,
      });
      const runs = await Promise.all(
        result.runs.map(async run => ({
          ...run,
          outcome: await workflowDb.getRunOutcome(run.id),
        }))
      );
      return c.json({ ...result, runs });
    } catch (error) {
      getLog().error({ err: error }, 'list_dashboard_runs_failed');
      return apiError(c, 500, 'Failed to list dashboard runs');
    }
  });

  // POST /api/workflows/runs/cancel-stale - Cancel all stale running workflow runs
  registerOpenApiRoute(cancelStaleWorkflowRunsRoute, async c => {
    try {
      const result = await workflowDb.cancelStaleWorkflowRuns(30);
      for (const runId of result.ids) {
        void workflowEventDb.createWorkflowEvent({
          workflow_run_id: runId,
          event_type: 'run_cancelled',
          data: { reason: 'stale_run_cleanup', actor: 'api' },
        });
      }
      return c.json({ cancelled: result.count, runIds: result.ids });
    } catch (error) {
      getLog().error({ err: error }, 'cancel_stale_workflow_runs_failed');
      return apiError(c, 500, 'Failed to cancel stale workflow runs');
    }
  });

  // POST /api/workflows/runs/:runId/cancel - Cancel a workflow run
  registerOpenApiRoute(cancelWorkflowRunRoute, async c => {
    try {
      const runId = c.req.param('runId') ?? '';
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return apiError(c, 404, 'Workflow run not found');
      }
      if (run.status === 'cancelled') {
        return apiError(c, 409, 'Workflow run is already cancelled');
      }
      if (run.status === 'completed' || run.status === 'failed') {
        return apiError(c, 422, `Cannot cancel workflow in '${run.status}' status`);
      }
      if (run.status !== 'running' && run.status !== 'pending' && run.status !== 'paused') {
        return apiError(c, 400, `Cannot cancel workflow in '${run.status}' status`);
      }
      const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
      const reason = body.reason ?? '';
      await workflowDb.cancelWorkflowRun(runId);
      void workflowEventDb.createWorkflowEvent({
        workflow_run_id: runId,
        event_type: 'run_cancelled',
        data: { reason, actor: 'api' },
      });
      const updated = await workflowDb.getWorkflowRun(runId);
      const updatedRun = updated ?? {
        ...run,
        status: 'cancelled' as const,
        completed_at: new Date().toISOString(),
      };
      return c.json({
        success: true,
        message: `Cancelled workflow: ${run.workflow_name}`,
        run: updatedRun,
      });
    } catch (error) {
      getLog().error({ err: error }, 'cancel_workflow_run_api_failed');
      return apiError(c, 500, 'Failed to cancel workflow run');
    }
  });

  // POST /api/workflows/runs/:runId/pause - Operator-triggered pause
  // Distinct from approval-gate pause (Rule of Three doctrine): no
  // ApprovalContext is required; the run flips to 'paused' and the global
  // Claude throttle blocks the next SDK call. Current iteration completes
  // naturally -- the DAG executor between-iteration check does not stop
  // running concurrent nodes (approval-gate semantics are preserved).
  registerOpenApiRoute(pauseWorkflowRunRoute, async c => {
    try {
      const runId = c.req.param('runId') ?? '';
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return apiError(c, 404, 'Workflow run not found');
      }
      if (run.status === 'paused') {
        return apiError(c, 409, 'Workflow run is already paused');
      }
      if (TERMINAL_WORKFLOW_STATUSES.includes(run.status)) {
        return apiError(c, 422, `Cannot pause workflow in '${run.status}' status`);
      }
      if (run.status !== 'running') {
        return apiError(c, 400, `Cannot pause workflow in '${run.status}' status`);
      }
      const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
      const reason = body.reason ?? '';
      await workflowDb.pauseWorkflowRunByOperator(runId);
      void workflowEventDb.createWorkflowEvent({
        workflow_run_id: runId,
        event_type: 'run_paused',
        data: { reason, actor: 'operator' },
      });
      const updated = await workflowDb.getWorkflowRun(runId);
      const updatedRun = updated ?? {
        ...run,
        status: 'paused' as const,
      };
      return c.json({
        success: true,
        message: `Paused workflow: ${run.workflow_name}`,
        run: updatedRun,
      });
    } catch (error) {
      getLog().error({ err: error }, 'pause_workflow_run_api_failed');
      return apiError(c, 500, 'Failed to pause workflow run');
    }
  });

  // POST /api/cascades/:cascadeId/approve-frontier - Resolve a paused premium
  // climb by resuming it (WO-HARNESS-FRONTIER-CLIMB-APPROVAL-GATE-01). The gate
  // paused an AUTOMATIC climb into a premium tier so premium usage is never
  // burned unattended; an operator approve fires the premium tier exactly once.
  // The claim file makes this idempotent: a second approve is a no-op.
  registerOpenApiRoute(approveFrontierRoute, async c => {
    const cascadeId = c.req.param('cascadeId') ?? '';
    try {
      const record = await readCascadeRecordById(cascadeId);
      if (!record) {
        return apiError(c, 404, 'Cascade not found');
      }
      if (!record.frontierApproval) {
        return apiError(c, 422, 'Cascade is not awaiting frontier approval');
      }
      // Exactly-once guard: the first resolver (approve or reject) wins; any
      // later call observes the recorded resolution and returns an idempotent
      // no-op WITHOUT firing again.
      const claim = await claimFrontierResolution(cascadeId, 'approved');
      if (!claim.claimed) {
        return c.json({
          success: true,
          message: `Cascade ${cascadeId} already resolved (${claim.resolution})`,
          cascadeId,
          resolution: claim.resolution,
          status: record.status,
          alreadyResolved: true,
        });
      }
      const token =
        c.req.header('x-archon-operator-token') ?? process.env.ARCHON_OPERATOR_TOKEN ?? '';
      // Resume in the background; return once the resumed record is durable so
      // the HTTP response does not block on the entire premium fire.
      let resolveAdmission: ((r: Awaited<ReturnType<typeof resumeFrontierTier>>) => void) | null =
        null;
      const admission = new Promise<Awaited<ReturnType<typeof resumeFrontierTier>>>(resolve => {
        resolveAdmission = resolve;
      });
      const resumePromise = resumeFrontierTier(record, {
        token,
        onAdmission: r => resolveAdmission?.(r),
      });
      void resumePromise.catch((error: unknown) => {
        getLog().error(
          { err: error, cascadeId, woId: record.woId },
          'frontier_approval_resume_failed'
        );
      });
      // Race so a synchronous resume failure surfaces as 500 instead of hanging.
      const admitted = await Promise.race([admission, resumePromise]);
      // A 'blocked' admission means the resumed cascade refused to fire because a
      // duplicate live cascade already holds the WO lock (smart-cauldron
      // acquireWoLock): nothing fired, no premium usage was spent, and the paused
      // record was left untouched by resumeFrontierTier. Roll back the approval
      // claim so the operator can retry/reject once the duplicate clears -- do NOT
      // report success, or the cascadeId would be wedged 'approved' forever with
      // neither a fire nor a path to re-resolve (WO Test 2 fail condition).
      if (admitted.status === 'blocked') {
        await releaseFrontierClaim(cascadeId);
        getLog().warn(
          { cascadeId, woId: record.woId, resumeCascadeId: admitted.cascadeId },
          'frontier_approval_resume_blocked'
        );
        return apiError(
          c,
          409,
          `Frontier resume for ${record.woId} could not fire: another cascade is already active for this WO. ` +
            'The approval was rolled back -- retry once it clears.'
        );
      }
      return c.json({
        success: true,
        message: `Approved frontier climb for ${record.woId}; resumed cascade ${admitted.cascadeId}`,
        cascadeId,
        resolution: 'approved' as const,
        status: admitted.status,
        resumeCascadeId: admitted.cascadeId,
      });
    } catch (error) {
      getLog().error({ err: error, cascadeId }, 'frontier_approval_approve_failed');
      return apiError(c, 500, 'Failed to approve frontier climb');
    }
  });

  // POST /api/cascades/:cascadeId/reject-frontier - Terminate a paused premium
  // climb as needs-human (no fire). Idempotent via the same claim file.
  registerOpenApiRoute(rejectFrontierRoute, async c => {
    const cascadeId = c.req.param('cascadeId') ?? '';
    try {
      const record = await readCascadeRecordById(cascadeId);
      if (!record) {
        return apiError(c, 404, 'Cascade not found');
      }
      if (!record.frontierApproval) {
        return apiError(c, 422, 'Cascade is not awaiting frontier approval');
      }
      const claim = await claimFrontierResolution(cascadeId, 'rejected');
      if (!claim.claimed) {
        return c.json({
          success: true,
          message: `Cascade ${cascadeId} already resolved (${claim.resolution})`,
          cascadeId,
          resolution: claim.resolution,
          status: record.status,
          alreadyResolved: true,
        });
      }
      const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
      const reason = body.reason ?? '';
      const updated = await rejectFrontierTier(record, reason);
      return c.json({
        success: true,
        message: `Rejected frontier climb for ${record.woId} (needs-human, no fire)`,
        cascadeId,
        resolution: 'rejected' as const,
        status: updated.status,
      });
    } catch (error) {
      getLog().error({ err: error, cascadeId }, 'frontier_approval_reject_failed');
      return apiError(c, 500, 'Failed to reject frontier climb');
    }
  });

  // GET /api/admin/throttle - Read the current global Claude provider throttle state
  registerOpenApiRoute(getAdminThrottleRoute, async c => {
    try {
      const paused = claudeProviderThrottle.isThrottled();
      const engageContext = claudeProviderThrottle.getEngageContext();
      return c.json({
        success: true,
        paused,
        message: paused
          ? `Throttle engaged by ${engageContext?.engagedBy ?? 'unknown'}`
          : 'Throttle is released',
        ...(engageContext?.engagedBy ? { engagedBy: engageContext.engagedBy } : {}),
      });
    } catch (error) {
      getLog().error({ err: error }, 'get_admin_throttle_api_failed');
      return apiError(c, 500, 'Failed to read throttle state');
    }
  });

  // POST /api/admin/throttle - Toggle the global Claude provider throttle gate
  // When paused=true, every subsequent Claude SDK call awaits release.
  // When paused=false, queued waiters drain FIFO.
  // Auto-throttle (rate-limit-triggered) and operator-throttle share the same
  // gate; setting paused=true here keeps the gate closed even if auto-release
  // would have opened it, because engageContext.engagedBy flips to 'operator'.
  registerOpenApiRoute(adminThrottleRoute, async c => {
    try {
      const body = (await c.req.json().catch(() => null)) as { paused?: unknown } | null;
      if (!body || typeof body.paused !== 'boolean') {
        return apiError(c, 400, 'Body must include { paused: boolean }');
      }
      const wasThrottled = claudeProviderThrottle.isThrottled();
      claudeProviderThrottle.setThrottled(body.paused, { engagedBy: 'operator' });
      const nowThrottled = claudeProviderThrottle.isThrottled();
      const engageContext = claudeProviderThrottle.getEngageContext();
      const message = body.paused
        ? wasThrottled
          ? 'Throttle was already engaged; engagement context refreshed'
          : 'Throttle engaged -- Claude SDK calls will queue'
        : wasThrottled
          ? 'Throttle released -- queued Claude SDK calls drained'
          : 'Throttle was already released';
      return c.json({
        success: true,
        paused: nowThrottled,
        message,
        ...(engageContext?.engagedBy ? { engagedBy: engageContext.engagedBy } : {}),
      });
    } catch (error) {
      getLog().error({ err: error }, 'admin_throttle_api_failed');
      return apiError(c, 500, 'Failed to update throttle state');
    }
  });

  registerOpenApiRoute(getAdminDrainRoute, async c => {
    try {
      const state = await workflowDb.getCauldronDrainState();
      return c.json({ success: true, ...state });
    } catch (error) {
      getLog().error({ err: error }, 'get_admin_drain_api_failed');
      return apiError(c, 500, 'Failed to read drain state');
    }
  });

  registerOpenApiRoute(getCanarySnapshotRoute, async c => {
    try {
      const query = (
        c.req as unknown as {
          valid(k: 'query'): { codebaseId: string; baseBranch: 'dev' };
        }
      ).valid('query');
      return c.json(await canarySnapshotBuilder(query.codebaseId, query.baseBranch));
    } catch (error) {
      getLog().error({ err: error }, 'get_canary_snapshot_api_failed');
      return apiError(c, 500, 'Failed to build canary snapshot');
    }
  });

  registerOpenApiRoute(adminDrainRoute, async c => {
    try {
      const body = getValidatedBody(c, drainBodySchema);
      const mode = body.draining ? 'draining' : 'normal';
      const actor =
        c.req.header('cf-access-authenticated-user-email')?.trim().toLowerCase() ?? 'operator';
      const updatedAt = new Date().toISOString();
      const transition = await workflowDb.setCauldronDrainMode({
        mode,
        actor,
        reason: body.reason ?? null,
        updatedAt,
      });
      const state = await workflowDb.getCauldronDrainState(updatedAt);
      return c.json({ success: true, changed: transition.changed, ...state });
    } catch (error) {
      getLog().error({ err: error }, 'admin_drain_api_failed');
      return apiError(c, 500, 'Failed to update drain state');
    }
  });

  // POST /api/workflows/runs/:runId/resume - Resume a workflow run
  //
  // Two modes share this route:
  //   1. Failed run     -> next invocation on the same path auto-resumes (legacy behavior)
  //   2. Operator pause -> flip status back to 'running'; the DAG executor's
  //                        between-iteration check sees 'running' and continues.
  //                        Approval-gate paused runs are NOT touched here -- use
  //                        /approve or /reject for those.
  registerOpenApiRoute(resumeWorkflowRunRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return apiError(c, 404, 'Workflow run not found');
      }
      if (!RESUMABLE_WORKFLOW_STATUSES.includes(run.status)) {
        return apiError(c, 400, `Cannot resume workflow in '${run.status}' status`);
      }

      // Operator-paused runs are flagged in metadata; flip them back to running.
      // Approval-gate pauses use metadata.approval (ApprovalContext) and resume
      // via /approve, so leave those alone here.
      const pausedByOperator = run.status === 'paused' && run.metadata.paused_by === 'operator';
      if (pausedByOperator) {
        await workflowDb.resumeWorkflowRunFromPause(runId);
        void workflowEventDb.createWorkflowEvent({
          workflow_run_id: runId,
          event_type: 'run_resumed',
          data: { actor: 'operator' },
        });
        return c.json({
          success: true,
          message: `Resumed workflow: ${run.workflow_name}`,
        });
      }

      // Failed run path (or approval-gate paused -- leave as-is, /approve handles it):
      // the next invocation on the same path auto-resumes from completed nodes.
      const pathInfo = run.working_path ? ` at \`${run.working_path}\`` : '';
      return c.json({
        success: true,
        message: `Workflow run ready to resume: ${run.workflow_name}${pathInfo}. Re-run the workflow to auto-resume from completed nodes.`,
      });
    } catch (error) {
      getLog().error({ err: error, runId }, 'api.workflow_run_resume_failed');
      return apiError(c, 500, 'Failed to resume workflow run');
    }
  });

  // POST /api/workflows/runs/:runId/abandon - Abandon a workflow run
  registerOpenApiRoute(abandonWorkflowRunRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return apiError(c, 404, 'Workflow run not found');
      }
      if (TERMINAL_WORKFLOW_STATUSES.includes(run.status)) {
        return apiError(c, 400, `Cannot abandon workflow in '${run.status}' status`);
      }
      await workflowDb.cancelWorkflowRun(runId);
      return c.json({ success: true, message: `Abandoned workflow: ${run.workflow_name}` });
    } catch (error) {
      getLog().error({ err: error, runId }, 'api.workflow_run_abandon_failed');
      return apiError(c, 500, 'Failed to abandon workflow run');
    }
  });

  // POST /api/workflows/runs/:runId/approve - Approve a paused workflow run
  registerOpenApiRoute(approveWorkflowRunRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        // WO-MC-APPROVE-GATE-RELIABILITY-01: log early-returns. The 2026-06-09
        // onramp incident left an 8-minute gap with no server-side trace of the
        // first click. Logging here turns "did the click arrive?" from a guess
        // into a fact in the archon logs.
        getLog().info({ runId }, 'api.workflow_run_approve_not_found');
        return apiError(c, 404, 'Workflow run not found');
      }
      // WO-MC-APPROVE-GATE-RELIABILITY-01: idempotency. Users re-click Approve
      // when the UI looks stuck. Once the gate is approved the route flips the
      // run to the 'failed' auto-resume sentinel and sets
      // metadata.approval_response='approved'. A second click then hit the
      // status!=='paused' guard and got a confusing 400 -- indistinguishable
      // from a real failure. Recognize the already-approved state and report
      // success without writing a duplicate approval_received or re-mutating
      // the run. Only standard approvals carry approval_response; interactive
      // loops do not, so they fall through to the normal paused-only path.
      const priorResponse = run.metadata.approval_response as string | undefined;
      if (run.status !== 'paused') {
        if (priorResponse === 'approved') {
          getLog().info(
            { runId, status: run.status },
            'api.workflow_run_approve_idempotent_already_approved'
          );
          return c.json({
            success: true,
            message: `Workflow already approved: ${run.workflow_name}.`,
          });
        }
        getLog().info(
          { runId, status: run.status },
          'api.workflow_run_approve_rejected_bad_status'
        );
        return apiError(c, 400, `Cannot approve workflow in '${run.status}' status`);
      }
      // Validate via the route schema so an invalid decision_verb is rejected with
      // 400 BEFORE anything is persisted. The OpenAPI defaultHook (validationErrorHook)
      // returns 400 on a Zod failure before this handler runs; Zod also applies the
      // .default('approve_as_is') so decision_verb is always a valid enum value here.
      const body = getValidatedBody(c, approveWorkflowRunBodySchema);
      const comment = body.comment ?? 'Approved';
      const decisionVerb = body.decision_verb; // schema default already applied
      const authorizedFixIds = body.authorized_fix_ids ?? [];
      const approval = run.metadata.approval as ApprovalContext | undefined;
      if (!approval?.nodeId) {
        getLog().warn({ runId }, 'api.workflow_run_approve_missing_context');
        return apiError(c, 400, 'Workflow run is paused but missing approval context');
      }
      // For interactive loops, do NOT write node_completed -- the executor writes it when
      // the AI emits the completion signal (actual loop exit). Writing it here would cause
      // the resume to skip the loop node entirely via priorCompletedNodes.
      if (approval.type !== 'interactive_loop') {
        // Design A: persist the graded decision verb + authorized fix ids INTO the
        // captured node_output as JSON, so the DAG when: evaluator can route on
        // $<gate>.output.decision_verb with no evaluator change. When the gate did not
        // capture a response, keep node_output empty (legacy binary contract).
        const nodeOutput =
          approval.captureResponse === true
            ? JSON.stringify({
                decision_verb: decisionVerb,
                authorized_fix_ids: authorizedFixIds,
                comment,
              })
            : '';
        await workflowEventDb.createWorkflowEvent({
          workflow_run_id: runId,
          event_type: 'node_completed',
          step_name: approval.nodeId,
          data: { node_output: nodeOutput, approval_decision: 'approved' },
        });
      }
      await workflowEventDb.createWorkflowEvent({
        workflow_run_id: runId,
        event_type: 'approval_received',
        step_name: approval.nodeId,
        data: { decision: 'approved', comment },
      });
      // For interactive loops, store user input; for standard approvals, mark as approved
      // and clear any rejection state.
      const metadataUpdate =
        approval.type === 'interactive_loop'
          ? { loop_user_input: comment }
          : { approval_response: 'approved', rejection_reason: '', rejection_count: 0 };
      await workflowDb.updateWorkflowRun(runId, {
        status: 'failed',
        metadata: metadataUpdate,
      });

      // Auto-resume: dispatch to the orchestrator so the workflow continues
      // without requiring the user to re-run the workflow command. Mirrors
      // what `workflowApproveCommand` does in the CLI. Requires
      // `parent_conversation_id` on the run (set by orchestrator-agent for any
      // web-dispatched workflow -- foreground, interactive, and background via
      // the pre-created run) and a web-platform parent (guarded in the helper).
      const autoResumed = await tryAutoResumeRun(run, 'approve');

      return c.json({
        success: true,
        message: autoResumed
          ? `Workflow approved: ${run.workflow_name}. Resuming workflow.`
          : `Workflow approved: ${run.workflow_name}. Send a message to continue.`,
      });
    } catch (error) {
      getLog().error({ err: error, runId }, 'api.workflow_run_approve_failed');
      return apiError(c, 500, 'Failed to approve workflow run');
    }
  });

  // POST /api/workflows/runs/:runId/reject - Reject a paused workflow run
  registerOpenApiRoute(rejectWorkflowRunRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        getLog().info({ runId }, 'api.workflow_run_reject_not_found');
        return apiError(c, 404, 'Workflow run not found');
      }
      // WO-MC-APPROVE-GATE-RELIABILITY-01: idempotency + observability, mirror
      // of the approve route. A reject on a paused gate either cancels the run
      // (no on_reject) or flips it to the 'failed' on_reject sentinel. If the
      // user re-clicks Reject after the run already went terminal-cancelled,
      // report success rather than a confusing 400.
      if (run.status !== 'paused') {
        if (run.status === 'cancelled') {
          getLog().info(
            { runId, status: run.status },
            'api.workflow_run_reject_idempotent_already_cancelled'
          );
          return c.json({
            success: true,
            message: `Workflow already rejected: ${run.workflow_name}.`,
          });
        }
        getLog().info({ runId, status: run.status }, 'api.workflow_run_reject_rejected_bad_status');
        return apiError(c, 400, `Cannot reject workflow in '${run.status}' status`);
      }
      const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
      const reason = body.reason ?? 'Rejected';
      const approval = run.metadata.approval as ApprovalContext | undefined;
      await workflowEventDb.createWorkflowEvent({
        workflow_run_id: runId,
        event_type: 'approval_received',
        step_name: approval?.nodeId ?? 'unknown',
        data: { decision: 'rejected', reason },
      });

      const hasOnReject = approval?.onRejectPrompt !== undefined;
      if (hasOnReject) {
        const currentCount = (run.metadata.rejection_count as number | undefined) ?? 0;
        const maxAttempts = approval?.onRejectMaxAttempts ?? 3;
        if (currentCount + 1 >= maxAttempts) {
          await workflowDb.cancelWorkflowRun(runId);
          return c.json({
            success: true,
            message: `Workflow rejected and cancelled (max attempts reached): ${run.workflow_name}`,
          });
        }
        await workflowDb.updateWorkflowRun(runId, {
          status: 'failed',
          metadata: { rejection_reason: reason, rejection_count: currentCount + 1 },
        });

        // Auto-resume: dispatch to the orchestrator so the on_reject prompt runs
        // without requiring the user to re-run the workflow command. Mirrors
        // what `workflowRejectCommand` does in the CLI. Same cross-adapter
        // guard as approve -- only web parents auto-resume.
        const autoResumed = await tryAutoResumeRun(run, 'reject');

        return c.json({
          success: true,
          message: autoResumed
            ? `Workflow rejected: ${run.workflow_name}. Running on-reject prompt.`
            : `Workflow rejected: ${run.workflow_name}. On-reject prompt will run on resume.`,
        });
      }

      await workflowDb.cancelWorkflowRun(runId);
      return c.json({
        success: true,
        message: `Workflow rejected: ${run.workflow_name}`,
      });
    } catch (error) {
      getLog().error({ err: error, runId }, 'api.workflow_run_reject_failed');
      return apiError(c, 500, 'Failed to reject workflow run');
    }
  });

  // POST /api/workflows/runs/:runId/archive
  registerOpenApiRoute(archiveWorkflowRunRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    try {
      const body = getValidatedBody(c, archiveWorkflowRunBodySchema);
      await workflowDb.archiveWorkflowRun(runId, 'operator', body.reason);
      const run = await workflowDb.getWorkflowRun(runId);
      return c.json({
        success: true,
        message: `Archived workflow run: ${run?.workflow_name ?? runId}`,
      });
    } catch (error) {
      const err = error as Error;
      if (err.message.includes('not found')) return apiError(c, 404, err.message);
      if (err.message.includes('cancel first')) return apiError(c, 400, err.message);
      getLog().error({ err, runId }, 'api.workflow_run_archive_failed');
      return apiError(c, 500, 'Failed to archive workflow run');
    }
  });

  // POST /api/workflows/runs/:runId/unarchive
  registerOpenApiRoute(unarchiveWorkflowRunRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    try {
      await workflowDb.unarchiveWorkflowRun(runId);
      const run = await workflowDb.getWorkflowRun(runId);
      return c.json({
        success: true,
        message: `Unarchived workflow run: ${run?.workflow_name ?? runId}`,
      });
    } catch (error) {
      const err = error as Error;
      if (err.message.includes('not found')) return apiError(c, 404, err.message);
      getLog().error({ err, runId }, 'api.workflow_run_unarchive_failed');
      return apiError(c, 500, 'Failed to unarchive workflow run');
    }
  });

  // POST /api/workflows/runs/bulk-archive -- MUST be before /{runId} routes
  registerOpenApiRoute(bulkArchiveWorkflowRunsRoute, async c => {
    try {
      const body = getValidatedBody(c, bulkArchiveBodySchema);
      const result = await workflowDb.bulkArchiveWorkflowRuns({
        status: body.status,
        olderThan: body.olderThan,
      });
      return c.json(result);
    } catch (error) {
      getLog().error({ err: error }, 'api.bulk_archive_runs_failed');
      return apiError(c, 500, 'Failed to bulk archive workflow runs');
    }
  });

  // DELETE /api/workflows/runs/bulk-failed -- MUST be before /{runId} routes
  registerOpenApiRoute(bulkDeleteFailedRunsRoute, async c => {
    try {
      const dryRun = c.req.query('dryRun') === 'true';
      const olderThanRaw = c.req.query('olderThan') ?? undefined;
      // bulkDeleteArchivedFailedRuns binds the cutoff directly into
      // started_at < $1 with no duration parsing. Human-readable shortcuts
      // (e.g. "14d", "30d", "1h") are accepted here and converted to an ISO
      // cutoff before being forwarded to the DB layer. ISO timestamps pass
      // through unchanged. Invalid values fail with a 400 instead of crashing
      // Postgres on a bad cast.
      let olderThan: string | undefined;
      if (olderThanRaw !== undefined) {
        const iso = parseDurationToIso(olderThanRaw);
        if (iso === null) {
          return apiError(
            c,
            400,
            `Invalid olderThan value: '${olderThanRaw}'. Use ISO timestamp (e.g. 2026-01-01T00:00:00Z) or duration shortcut (e.g. 14d, 7d, 1h).`
          );
        }
        olderThan = iso;
      }
      const result = await workflowDb.bulkDeleteArchivedFailedRuns({ dryRun, olderThan });
      return c.json({ ...result, dryRun });
    } catch (error) {
      getLog().error({ err: error }, 'api.bulk_delete_failed_runs_error');
      return apiError(c, 500, 'Failed to bulk delete failed workflow runs');
    }
  });

  // DELETE /api/workflows/runs/:runId - Delete a workflow run
  registerOpenApiRoute(deleteWorkflowRunRoute, async c => {
    const runId = c.req.param('runId') ?? '';
    const force = c.req.query('force') === 'true';
    try {
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return apiError(c, 404, 'Workflow run not found');
      }
      if (!TERMINAL_WORKFLOW_STATUSES.includes(run.status)) {
        return apiError(
          c,
          400,
          `Cannot delete workflow in '${run.status}' status -- cancel it first`
        );
      }
      await workflowDb.deleteWorkflowRun(runId, force);
      getLog().info(
        { runId, workflowName: run.workflow_name, force, action: 'delete' },
        'workflow_run.deleted'
      );
      return c.json({ success: true, message: `Deleted workflow run: ${run.workflow_name}` });
    } catch (error) {
      const err = error as Error;
      if (err.message.includes('Archive the run first')) {
        return apiError(c, 400, err.message);
      }
      getLog().error({ err: error, runId }, 'api.workflow_run_delete_failed');
      return apiError(c, 500, 'Failed to delete workflow run');
    }
  });

  // GET /api/workflows/runs - List workflow runs
  registerOpenApiRoute(listWorkflowRunsRoute, async c => {
    try {
      const conversationId = c.req.query('conversationId') ?? undefined;
      const rawStatus = c.req.query('status');
      const validStatuses = [
        'pending',
        'running',
        'waiting_provider',
        'interrupted',
        'completed',
        'failed',
        'cancelled',
        'paused',
      ] as const;
      type WorkflowRunStatus = (typeof validStatuses)[number];
      const status: WorkflowRunStatus | undefined =
        rawStatus && (validStatuses as readonly string[]).includes(rawStatus)
          ? (rawStatus as WorkflowRunStatus)
          : undefined;
      const codebaseId = c.req.query('codebaseId') ?? undefined;
      const limitRaw = Number(c.req.query('limit'));
      const limit = Number.isNaN(limitRaw) ? 50 : Math.min(Math.max(1, limitRaw), 200);

      const runs = await workflowDb.listWorkflowRuns({
        conversationId,
        status,
        limit,
        codebaseId,
      });
      const runsWithOutcomes = await Promise.all(
        runs.map(async run => ({
          ...run,
          outcome: await workflowDb.getRunOutcome(run.id),
        }))
      );
      // computeQuotaWindow queries the DB independently of the runs page so
      // windowTokens reflects ALL in-window runs, not just this page.
      const quotaWindow = await computeQuotaWindow(codebaseId);
      return c.json({ runs: runsWithOutcomes, quotaWindow });
    } catch (error) {
      getLog().error({ err: error }, 'list_workflow_runs_failed');
      return apiError(c, 500, 'Failed to list workflow runs');
    }
  });

  // GET /api/workflows/runs/by-worker/:platformId - Look up run by worker conversation
  // Must be registered before :runId to avoid "by-worker" matching as a runId
  registerOpenApiRoute(getWorkflowRunByWorkerRoute, async c => {
    try {
      const platformId = c.req.param('platformId') ?? '';
      const run = await workflowDb.getWorkflowRunByWorkerPlatformId(platformId);
      if (!run) {
        return apiError(c, 404, 'No workflow run found for this worker');
      }
      return c.json({ run: { ...run, outcome: await workflowDb.getRunOutcome(run.id) } });
    } catch (error) {
      getLog().error({ err: error }, 'workflow_run_by_worker_lookup_failed');
      return apiError(c, 500, 'Failed to look up workflow run');
    }
  });

  // GET /api/workflows/runs/:runId - Get run details with events
  registerOpenApiRoute(getWorkflowRunRoute, async c => {
    try {
      const runId = c.req.param('runId') ?? '';
      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return apiError(c, 404, 'Workflow run not found');
      }
      const events = await workflowEventDb.listWorkflowEvents(runId);
      const outcome = await workflowDb.getRunOutcome(runId);
      const tokenTotalsEvent = [...events]
        .reverse()
        .find(event => event.event_type === 'run_token_totals');

      // Look up the run's conversation platform ID.
      // For web runs (parent_conversation_id set): conversation_id is the worker conversation -> set worker_platform_id
      // For CLI runs (no parent): conversation_id is the single conversation -> set conversation_platform_id only
      let workerPlatformId: string | undefined;
      let conversationPlatformId: string | undefined;
      if (run.conversation_id) {
        const conv = await conversationDb.getConversationById(run.conversation_id);
        if (run.parent_conversation_id) {
          // Web run: conversation_id points to the worker conversation
          workerPlatformId = conv?.platform_conversation_id;
        } else {
          // CLI run: conversation_id is the only conversation (no worker/parent split)
          conversationPlatformId = conv?.platform_conversation_id;
        }
      }

      // Look up parent conversation to get its platform_conversation_id for navigation
      let parentPlatformId: string | undefined;
      if (run.parent_conversation_id) {
        const parentConv = await conversationDb.getConversationById(run.parent_conversation_id);
        parentPlatformId = parentConv?.platform_conversation_id;
      }

      return c.json({
        run: {
          ...run,
          outcome,
          worker_platform_id: workerPlatformId,
          parent_platform_id: parentPlatformId,
          conversation_platform_id: conversationPlatformId ?? null,
          ...(tokenTotalsEvent ? { token_totals: tokenTotalsEvent.data } : {}),
        },
        events,
      });
    } catch (error) {
      getLog().error({ err: error }, 'get_workflow_run_failed');
      return apiError(c, 500, 'Failed to get workflow run');
    }
  });

  // GET /api/workflows/runs/:runId/nodes/:nodeId/events - Last N events for one node
  // Used by the NodePeekPanel in the DAG viz to show per-node activity without SSH.
  registerOpenApiRoute(getNodeEventsRoute, async c => {
    try {
      const runId = c.req.param('runId') ?? '';
      const nodeId = c.req.param('nodeId') ?? '';
      const limitParam = c.req.query('limit');

      // Default 5; clamp to [1, 20] to bound DB load.
      let limit = 5;
      if (limitParam !== undefined) {
        const parsed = Number.parseInt(limitParam, 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          limit = 1;
        } else if (parsed > 20) {
          limit = 20;
        } else {
          limit = parsed;
        }
      }

      const run = await workflowDb.getWorkflowRun(runId);
      if (!run) {
        return apiError(c, 404, 'Workflow run not found');
      }

      const events = await workflowEventDb.listNodeEvents(runId, nodeId, limit);
      return c.json({ events });
    } catch (error) {
      getLog().error({ err: error }, 'get_node_events_failed');
      return apiError(c, 500, 'Failed to get node events');
    }
  });

  // POST /api/workflows/validate - Validate a workflow definition without saving
  // MUST be registered before GET /api/workflows/:name so "validate" is not treated as :name
  registerOpenApiRoute(validateWorkflowRoute, async c => {
    const { definition } = getValidatedBody(c, validateWorkflowBodySchema);

    let yamlContent: string;
    try {
      yamlContent = Bun.YAML.stringify(definition);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err }, 'workflow.serialize_failed');
      return apiError(c, 400, 'Failed to serialize workflow definition');
    }

    try {
      const result = parseWorkflow(yamlContent, 'validate-input.yaml');

      if (result.error) {
        return c.json({ valid: false, errors: [result.error.error] });
      }
      return c.json({ valid: true });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err }, 'workflow.validate_failed');
      return apiError(c, 500, 'Failed to validate workflow');
    }
  });

  // GET /api/workflows/:name - Fetch a single workflow definition
  registerOpenApiRoute(getWorkflowRoute, async c => {
    const name = c.req.param('name') ?? '';
    if (!isValidCommandName(name)) {
      return apiError(c, 400, 'Invalid workflow name');
    }

    try {
      const cwd = c.req.query('cwd');
      let workingDir = cwd;
      if (cwd) {
        if (!(await validateCwd(cwd))) {
          return apiError(c, 400, 'Invalid cwd: must match a registered codebase path');
        }
      } else {
        const codebases = await codebaseDb.listCodebases();
        if (codebases.length > 0) workingDir = codebases[0].default_cwd;
      }

      const filename = `${name}.yaml`;

      // 1. Try user-defined workflow in cwd
      if (workingDir) {
        const [workflowFolder] = getWorkflowFolderSearchPaths();
        const filePath = join(workingDir, workflowFolder, filename);
        try {
          const content = await readFile(filePath, 'utf-8');
          const result = parseWorkflow(content, filename);
          if (result.error) {
            return apiError(c, 500, `Workflow file is invalid: ${result.error.error}`);
          }
          return c.json({
            workflow: result.workflow,
            filename,
            source: 'project' as WorkflowSource,
          });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            getLog().error({ err, name }, 'workflow.fetch_failed');
            return apiError(c, 500, 'Failed to read workflow');
          }
        }
      }

      // 2. Fall back to bundled defaults (binary: embedded map; dev: also check filesystem)
      if (Object.hasOwn(BUNDLED_WORKFLOWS, name)) {
        const bundledContent = BUNDLED_WORKFLOWS[name];
        const result = parseWorkflow(bundledContent, filename);
        if (result.error) {
          return apiError(c, 500, `Bundled workflow is invalid: ${result.error.error}`);
        }
        return c.json({ workflow: result.workflow, filename, source: 'bundled' as WorkflowSource });
      }

      if (!isBinaryBuild()) {
        const defaultFilePath = join(getDefaultWorkflowsPath(), filename);
        try {
          const content = await readFile(defaultFilePath, 'utf-8');
          const result = parseWorkflow(content, filename);
          if (result.error) {
            return apiError(c, 500, `Default workflow is invalid: ${result.error.error}`);
          }
          return c.json({
            workflow: result.workflow,
            filename,
            source: 'bundled' as WorkflowSource,
          });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            getLog().error({ err, name }, 'workflow.fetch_default_failed');
            return apiError(c, 500, 'Failed to read default workflow');
          }
        }
      }

      return apiError(c, 404, `Workflow not found: ${name}`);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err, name }, 'workflow.get_failed');
      return apiError(c, 500, 'Failed to get workflow');
    }
  });

  // PUT /api/workflows/:name - Save (create or update) a workflow
  registerOpenApiRoute(saveWorkflowRoute, async c => {
    const name = c.req.param('name') ?? '';
    if (!isValidCommandName(name)) {
      return apiError(c, 400, 'Invalid workflow name');
    }

    const cwd = c.req.query('cwd');
    let workingDir = cwd;
    if (cwd) {
      if (!(await validateCwd(cwd))) {
        return apiError(c, 400, 'Invalid cwd: must match a registered codebase path');
      }
    } else {
      const codebases = await codebaseDb.listCodebases();
      if (codebases.length > 0) workingDir = codebases[0].default_cwd;
    }
    if (!workingDir) {
      workingDir = getArchonHome();
    }

    const { definition } = getValidatedBody(c, saveWorkflowBodySchema);

    // Serialize and validate before writing
    let yamlContent: string;
    try {
      yamlContent = Bun.YAML.stringify(definition);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err, name }, 'workflow.serialize_failed');
      return apiError(c, 400, 'Failed to serialize workflow definition');
    }

    const parsed = parseWorkflow(yamlContent, `${name}.yaml`);
    if (parsed.error) {
      return apiError(c, 400, 'Workflow definition is invalid', parsed.error.error);
    }
    const knownBadBinding = await rejectKnownBadWorkflowBinding(parsed.workflow, workingDir);
    if (knownBadBinding) {
      return apiError(
        c,
        400,
        'Workflow definition is blocked by known bad binding',
        knownBadBinding
      );
    }

    try {
      const [workflowFolder] = getWorkflowFolderSearchPaths();
      const dirPath = join(workingDir, workflowFolder);
      await mkdir(dirPath, { recursive: true });
      const filePath = join(dirPath, `${name}.yaml`);
      await writeFile(filePath, yamlContent, 'utf-8');
      return c.json({
        workflow: parsed.workflow,
        filename: `${name}.yaml`,
        source: 'project' as WorkflowSource,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err, name }, 'workflow.save_failed');
      return apiError(c, 500, 'Failed to save workflow');
    }
  });

  // DELETE /api/workflows/:name - Delete a user-defined workflow
  registerOpenApiRoute(deleteWorkflowRoute, async c => {
    const name = c.req.param('name') ?? '';
    if (!isValidCommandName(name)) {
      return apiError(c, 400, 'Invalid workflow name');
    }

    // Refuse to delete bundled defaults
    if (Object.hasOwn(BUNDLED_WORKFLOWS, name)) {
      return apiError(c, 400, `Cannot delete bundled default workflow: ${name}`);
    }

    const cwd = c.req.query('cwd');
    let workingDir = cwd;
    if (cwd) {
      if (!(await validateCwd(cwd))) {
        return apiError(c, 400, 'Invalid cwd: must match a registered codebase path');
      }
    } else {
      const codebases = await codebaseDb.listCodebases();
      if (codebases.length > 0) workingDir = codebases[0].default_cwd;
    }
    if (!workingDir) {
      workingDir = getArchonHome();
    }

    const [workflowFolder] = getWorkflowFolderSearchPaths();
    const filePath = join(workingDir, workflowFolder, `${name}.yaml`);

    try {
      await unlink(filePath);
      return c.json({ deleted: true, name });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return apiError(c, 404, `Workflow not found: ${name}`);
      }
      getLog().error({ err, name }, 'workflow.delete_failed');
      return apiError(c, 500, 'Failed to delete workflow');
    }
  });

  // GET /api/commands - List available command names for the workflow node palette
  registerOpenApiRoute(getCommandsRoute, async c => {
    try {
      const cwd = c.req.query('cwd');
      let workingDir = cwd;
      if (cwd) {
        if (!(await validateCwd(cwd))) {
          return apiError(c, 400, 'Invalid cwd: must match a registered codebase path');
        }
      } else {
        const codebases = await codebaseDb.listCodebases();
        if (codebases.length > 0) workingDir = codebases[0].default_cwd;
      }

      // Collect commands: precedence bundled < global < project (repo-defined wins).
      const commandMap = new Map<string, WorkflowSource>();

      // 1. Seed with bundled defaults
      for (const name of Object.keys(BUNDLED_COMMANDS)) {
        commandMap.set(name, 'bundled');
      }

      // maxDepth: 1 matches the executor's resolver (resolveCommand /
      // loadCommandPrompt) -- without this cap, the UI palette would surface
      // commands buried in deep subfolders that the executor silently can't
      // resolve at runtime.
      const COMMAND_LIST_DEPTH = { maxDepth: 1 };

      // 2. If not binary build, also check filesystem defaults
      if (!isBinaryBuild()) {
        try {
          const defaultsPath = getDefaultCommandsPath();
          const files = await findMarkdownFilesRecursive(defaultsPath, '', COMMAND_LIST_DEPTH);
          for (const { commandName } of files) {
            commandMap.set(commandName, 'bundled');
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            getLog().error({ err }, 'commands.list_defaults_failed');
          }
          // ENOENT: defaults path missing -- not an error
        }
      }

      // 3. Home-scoped commands (~/.archon/commands/) override bundled
      try {
        const homeCommandsPath = getHomeCommandsPath();
        const files = await findMarkdownFilesRecursive(homeCommandsPath, '', COMMAND_LIST_DEPTH);
        for (const { commandName } of files) {
          commandMap.set(commandName, 'global');
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          getLog().error({ err }, 'commands.list_home_failed');
        }
        // ENOENT: home commands dir not created yet -- not an error
      }

      // 4. Project-defined commands override bundled AND global
      if (workingDir) {
        const searchPaths = getCommandFolderSearchPaths();
        for (const folder of searchPaths) {
          const dirPath = join(workingDir, folder);
          try {
            const files = await findMarkdownFilesRecursive(dirPath, '', COMMAND_LIST_DEPTH);
            for (const { commandName } of files) {
              commandMap.set(commandName, 'project');
            }
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              getLog().error({ err, dirPath }, 'commands.list_project_failed');
            }
            // ENOENT: folder doesn't exist -- skip
          }
        }
      }

      const commands = Array.from(commandMap.entries()).map(([name, source]) => ({ name, source }));
      return c.json({ commands });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      getLog().error({ err }, 'commands.list_failed');
      return apiError(c, 500, 'Failed to list commands');
    }
  });

  // GET /api/artifacts/:runId/* - Serve workflow artifact file contents
  // The wildcard captures the filename (e.g. "plan.md", "subdir/report.md").
  // Path traversal is blocked: any segment containing ".." is rejected.
  // NOTE: Uses app.get() instead of registerOpenApiRoute because:
  //  1. Wildcard path params (*) are not representable in OpenAPI 3.0
  //  2. Response is raw text/markdown, not JSON
  app.get('/api/artifacts/:runId/*', async c => {
    const runId = c.req.param('runId');
    // Hono wildcards match but don't capture -- extract filename from the URL path.
    // c.req.path is NOT percent-decoded, so we decode it manually.
    const prefix = `/api/artifacts/${runId}/`;
    const rawEncoded = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : '';
    let rawFilename: string;
    try {
      rawFilename = decodeURIComponent(rawEncoded);
    } catch {
      return apiError(c, 400, 'Invalid filename');
    }

    // Block path traversal: reject if any segment is ".." or contains null bytes
    if (
      !rawFilename ||
      rawFilename.includes('\0') ||
      rawFilename.split('/').some(s => s === '..')
    ) {
      return apiError(c, 400, 'Invalid filename');
    }

    // Normalize and ensure relative (no leading slash)
    const filename = normalize(rawFilename).replace(/^[/\\]+/, '');
    if (!filename) {
      return apiError(c, 400, 'Invalid filename');
    }

    let run: Awaited<ReturnType<typeof workflowDb.getWorkflowRun>>;
    try {
      run = await workflowDb.getWorkflowRun(runId);
    } catch (error) {
      getLog().error({ err: error, runId }, 'artifacts.run_lookup_failed');
      return apiError(c, 500, 'Failed to look up workflow run');
    }

    if (!run) {
      return apiError(c, 404, 'Workflow run not found');
    }

    // Derive owner/repo from codebase name (format: "owner/repo")
    const codebase = run.codebase_id ? await codebaseDb.getCodebase(run.codebase_id) : null;
    if (!codebase?.name) {
      getLog().error({ runId, codebaseId: run.codebase_id }, 'artifacts.codebase_lookup_failed');
      return apiError(c, 404, 'Artifact not available: codebase not found');
    }
    const nameParts = codebase.name.split('/');
    if (nameParts.length < 2) {
      getLog().error({ runId, codebaseName: codebase.name }, 'artifacts.owner_repo_parse_failed');
      return apiError(c, 404, 'Artifact not available: could not determine owner/repo');
    }
    const [owner, repo] = nameParts;

    const artifactDir = getRunArtifactsPath(owner, repo, runId);
    const filePath = join(artifactDir, filename);

    // Final safety check: ensure resolved path stays within artifact directory
    if (
      !normalize(filePath).startsWith(normalize(artifactDir) + sep) &&
      normalize(filePath) !== normalize(artifactDir)
    ) {
      getLog().warn({ runId, filename, filePath, artifactDir }, 'artifacts.path_escape_blocked');
      return apiError(c, 400, 'Invalid filename');
    }

    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return apiError(c, 404, 'Artifact file not found');
      }
      getLog().error({ err, runId, filename }, 'artifacts.read_failed');
      return apiError(c, 500, 'Failed to read artifact file');
    }

    const contentType = filename.endsWith('.md')
      ? 'text/markdown; charset=utf-8'
      : 'text/plain; charset=utf-8';
    return new Response(content, {
      status: 200,
      headers: { 'Content-Type': contentType },
    });
  });

  // GET /api/config - Read-only configuration (safe subset only -- no filesystem paths)
  registerOpenApiRoute(getConfigRoute, async c => {
    try {
      const config = await loadConfig();
      return c.json({
        config: toSafeConfig(config),
        database: getDatabaseType(),
      });
    } catch (error) {
      getLog().error({ err: error }, 'get_config_failed');
      return apiError(c, 500, 'Failed to get config');
    }
  });

  // PATCH /api/config/assistants - Update assistant configuration
  registerOpenApiRoute(patchAssistantConfigRoute, async c => {
    try {
      const body = getValidatedBody(c, updateAssistantConfigBodySchema);

      const updates: Partial<GlobalConfig> = {};
      if (body.assistant !== undefined) {
        if (!isRegisteredProvider(body.assistant)) {
          return apiError(
            c,
            400,
            `Unknown provider '${body.assistant}'. Available: ${getProviderInfoList()
              .map(p => p.id)
              .join(', ')}`
          );
        }
        updates.defaultAssistant = body.assistant;
      }
      if (body.assistants !== undefined) {
        const unknownProviders = Object.keys(body.assistants).filter(
          id => !isRegisteredProvider(id)
        );
        if (unknownProviders.length > 0) {
          return apiError(
            c,
            400,
            `Unknown provider(s) in assistants: ${unknownProviders.join(', ')}. Available: ${getProviderInfoList()
              .map(p => p.id)
              .join(', ')}`
          );
        }
        updates.assistants = body.assistants;
      }

      await updateGlobalConfig(updates);

      const config = await loadConfig();
      return c.json({
        config: toSafeConfig(config),
        database: getDatabaseType(),
      });
    } catch (error) {
      getLog().error({ err: error }, 'config.assistants_update_failed');
      return apiError(c, 500, 'Failed to update assistant configuration');
    }
  });

  // GET /api/providers - List registered AI providers
  registerOpenApiRoute(getProvidersRoute, c => {
    return c.json({ providers: getProviderInfoList() });
  });

  // GET /api/codebases/:id/environments - List isolation environments for a codebase
  registerOpenApiRoute(getCodebaseEnvironmentsRoute, async c => {
    try {
      const { id } = c.req.param();
      const codebase = await codebaseDb.getCodebase(id);
      if (!codebase) {
        return apiError(c, 404, 'Codebase not found');
      }

      const environments = await isolationEnvDb.listByCodebaseWithAge(id);
      return c.json({ environments });
    } catch (error) {
      getLog().error({ err: error }, 'codebases.environments_list_failed');
      return apiError(c, 500, 'Failed to list environments');
    }
  });

  // GET /api/health - Health check with web adapter info
  registerOpenApiRoute(getHealthRoute, async c => {
    const stats = lockManager.getStats();
    const runningWorkflowRows = await workflowDb.getRunningWorkflows();

    // Merge lock-based and DB-based active tracking.
    // Background workflows bypass the lock manager, so we combine both sources.
    const lockActiveSet = new Set(stats.activeConversationIds);
    const backgroundConversationIds = runningWorkflowRows
      .map(r => r.conversation_id)
      .filter(id => !lockActiveSet.has(id));
    const allActiveIds = [...stats.activeConversationIds, ...backgroundConversationIds];

    const overseerStatus = await getOverseerRuntimeStatus({
      listCapabilityStates: listOverseerCapabilityStates,
      getLastActionAt: getOverseerLastActionAt,
      getLastVerdictAt: getOverseerLastVerdictAt,
      countPendingJudgments: countRunsPendingOverseerJudgment,
    });

    return c.json({
      status: overseerStatus.status,
      adapter: 'web',
      concurrency: {
        ...stats,
        active: allActiveIds.length,
        activeConversationIds: allActiveIds,
      },
      runningWorkflows: runningWorkflowRows.length,
      version: appVersion,
      is_docker: isDocker(),
      activePlatforms: activePlatforms ? [...activePlatforms] : ['Web'],
      overseer: overseerStatus,
    });
  });

  // GET /api/host-metrics - Read /host-artifacts/host-metrics.json written by
  // the host-side collector (separate WO in bdc-xo). Returns the parsed JSON
  // plus a stale flag if collectedAt is older than 10 minutes. Returns a
  // documented 'no-data' shape (NOT a 500) when the file is absent so the
  // dashboard can render "awaiting collector" cleanly before the collector
  // is deployed.
  registerOpenApiRoute(getHostMetricsRoute, async c => {
    const noData = {
      status: 'no-data' as const,
      disk: null,
      cpu: null,
      mem: null,
      collectedAt: null,
      stale: false,
    };
    try {
      const raw = await readFile('/host-artifacts/host-metrics.json', 'utf8');
      const parsedJson: unknown = JSON.parse(raw);
      const parsedObj =
        typeof parsedJson === 'object' && parsedJson !== null
          ? (parsedJson as Record<string, unknown>)
          : {};
      const collectedAtRaw = parsedObj.collectedAt;
      const collectedAt = typeof collectedAtRaw === 'string' ? collectedAtRaw : null;
      // Stale = collectedAt older than 10 minutes. If collectedAt is missing
      // or unparseable we treat the data as stale (we can still show the
      // last values, but flag them).
      let stale = true;
      if (collectedAt) {
        const ts = Date.parse(collectedAt);
        if (!Number.isNaN(ts)) {
          stale = Date.now() - ts > 10 * 60 * 1000;
        }
      }
      // Validate the parsed collector output against the response schema so
      // malformed numeric fields (e.g. unexpected strings) cannot leak past
      // the OpenAPI contract. On schema mismatch, log and fall back to the
      // no-data shape rather than serving an off-contract payload.
      const candidate = {
        status: stale ? ('stale' as const) : ('ok' as const),
        disk: parsedObj.disk ?? null,
        cpu: parsedObj.cpu ?? null,
        mem: parsedObj.mem ?? null,
        collectedAt,
        stale,
      };
      const validation = hostMetricsBodySchema.safeParse(candidate);
      if (!validation.success) {
        getLog().warn({ issues: validation.error.issues }, 'api.host_metrics_contract_violation');
        return c.json(noData);
      }
      return c.json(validation.data);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        // Collector has not yet written the file. Surface a clear placeholder
        // shape to the panel, not a 500.
        return c.json(noData);
      }
      getLog().error({ err: error }, 'api.host_metrics_read_failed');
      // Unexpected error (bad JSON, permissions, etc.) -- still return the
      // no-data shape so the panel does not crash; the failure is logged.
      return c.json(noData);
    }
  });

  registerOpenApiRoute(getUpdateCheckRoute, async c => {
    const noUpdate = {
      updateAvailable: false,
      currentVersion: appVersion,
      latestVersion: appVersion,
      releaseUrl: '',
    };
    if (!BUNDLED_IS_BINARY) return c.json(noUpdate);
    const result = await checkForUpdate(appVersion);
    return c.json(result ?? noUpdate);
  });
}
