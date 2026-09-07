/**
 * Provider Registry
 *
 * Typed registry where each entry is a ProviderRegistration record (factory + metadata).
 * Replaces the hardcoded factory switch from Phase 1.
 *
 * Bootstrap: callers must call registerBuiltinProviders() at process entrypoints
 * (server startup, CLI init) before any provider lookups.
 */
import type {
  IAgentProvider,
  ProviderCapabilities,
  ProviderRegistration,
  ProviderInfo,
  ProviderExecutionCapability,
} from './types';
import { ClaudeProvider } from './claude/provider';
import { CodexProvider } from './codex/provider';
import { CLAUDE_CAPABILITIES } from './claude/capabilities';
import { CODEX_CAPABILITIES } from './codex/capabilities';
import { registerPiProvider } from './community/pi/registration';
import {
  registerGlmProvider,
  registerOprProvider,
  registerOprZeroProvider,
} from './community/glm/registration';
import { registerGrokAgentProvider } from './community/grok/registration';
import { GlmProvider } from './community/glm/provider';
import { UnknownProviderError } from './errors';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.registry');
  return cachedLog;
}

/** Backing store for registered providers. */
const registry = new Map<string, ProviderRegistration>();

/**
 * Register a provider. Throws on duplicate registration.
 */
export function registerProvider(entry: ProviderRegistration): void {
  if (registry.has(entry.id)) {
    throw new Error(`Provider '${entry.id}' is already registered`);
  }
  registry.set(entry.id, entry);
  getLog().debug({ provider: entry.id, builtIn: entry.builtIn }, 'provider.registered');
}

/**
 * Get an instantiated agent provider by ID.
 * @throws UnknownProviderError if not registered
 */
export function getAgentProvider(id: string): IAgentProvider {
  const entry = registry.get(id);
  if (!entry) {
    throw new UnknownProviderError(id, [...registry.keys()]);
  }
  getLog().debug({ provider: id }, 'provider_selected');
  return entry.factory();
}

/**
 * Get the full registration entry for a provider.
 * @throws UnknownProviderError if not registered
 */
export function getRegistration(id: string): ProviderRegistration {
  const entry = registry.get(id);
  if (!entry) {
    throw new UnknownProviderError(id, [...registry.keys()]);
  }
  return entry;
}

/**
 * Get provider capabilities without instantiating a provider.
 * @throws UnknownProviderError if not registered
 */
export function getProviderCapabilities(id: string): ProviderCapabilities {
  return getRegistration(id).capabilities;
}

/** Return required execution capabilities the provider cannot supply. */
export function getMissingProviderExecutionCapabilities(
  id: string,
  required: readonly ProviderExecutionCapability[]
): ProviderExecutionCapability[] {
  const execution = getProviderCapabilities(id).execution;
  return required.filter(capability => !execution[capability]);
}

/**
 * Get all registered providers.
 */
export function getRegisteredProviders(): ProviderRegistration[] {
  return [...registry.values()];
}

/**
 * Get API-safe provider info (excludes the factory).
 */
export function getProviderInfoList(): ProviderInfo[] {
  return getRegisteredProviders().map(({ id, displayName, capabilities, builtIn }) => ({
    id,
    displayName,
    capabilities,
    builtIn,
  }));
}

/**
 * Check if a provider is registered.
 */
export function isRegisteredProvider(id: string): boolean {
  return registry.has(id);
}

/**
 * Register built-in providers (Claude, Codex). Idempotent -- skips already-registered IDs.
 * Must be called at process entrypoints (server, CLI) before any provider lookups.
 */
export function registerBuiltinProviders(): void {
  const builtins: ProviderRegistration[] = [
    {
      id: 'claude',
      displayName: 'Claude (Anthropic)',
      factory: () => new ClaudeProvider(),
      capabilities: CLAUDE_CAPABILITIES,
      builtIn: true,
    },
    {
      id: 'codex',
      displayName: 'Codex (OpenAI)',
      // WO-HARNESS-CODEX-THREAD-RESUME-AND-FAILBACK-01: wire ClaudeProvider as the
      // failback factory so terminal Codex failures (rollout-missing after restart,
      // crash retries exhausted) delegate to a Claude reviewer with disclosure
      // rather than blocking the review gate. The factory is invoked lazily inside
      // sendQuery so the Claude instance is constructed only when actually needed.
      factory: () => new CodexProvider({ failbackProviderFactory: () => new ClaudeProvider() }),
      capabilities: CODEX_CAPABILITIES,
      builtIn: true,
    },
    {
      // Minimal reuse from PR #655, head 20847cd4e6a59b6c2b61060c348ff58d3e9fdab3.
      id: 'codex-native-strict',
      displayName: 'Codex Native Strict',
      factory: () => new CodexProvider({ failbackProviderFactory: null }),
      capabilities: CODEX_CAPABILITIES,
      builtIn: true,
    },
    {
      id: 'codex-opr',
      displayName: 'Codex with OpenRouter failback',
      factory: () =>
        new CodexProvider({
          failbackProviderFactory: () =>
            new GlmProvider({
              assistantConfig: { model: 'deepseek/deepseek-chat-v3.1' },
              failbackProviderFactory: null,
            }),
          failbackLabel: 'OpenRouter',
          failbackEventName: 'codex_failback_to_openrouter',
        }),
      capabilities: CODEX_CAPABILITIES,
      builtIn: true,
    },
  ];

  for (const entry of builtins) {
    if (!registry.has(entry.id)) {
      registry.set(entry.id, entry);
      getLog().debug({ provider: entry.id }, 'builtin_provider.registered');
    }
  }
}

/**
 * Register all bundled community providers in one call.
 *
 * Process entrypoints (server, CLI, config-loader) call this once after
 * `registerBuiltinProviders()`. Adding a new community provider means:
 *   1. Drop the implementation under `packages/providers/src/community/<id>/`.
 *   2. Export a `register<Name>Provider()` function from it.
 *   3. Import + call it here.
 *
 * That's the entire cross-cutting change outside the provider's own
 * directory. No entrypoint edits, no config-type edits -- just add a line
 * to this function. That's the Phase 2 contract (#1195): community
 * providers are a localized addition.
 *
 * Each `register*Provider` is itself idempotent, so calling this
 * aggregator multiple times (e.g. from both CLI and config-loader paths)
 * is safe. Errors during registration are not caught here -- a broken
 * community provider should fail loud at bootstrap, not silently
 * disappear.
 */
export function registerCommunityProviders(): void {
  registerPiProvider();
  // WO-HARNESS-SMART-CAULDRON-LANE-ROSTER-AND-RESILIENCE-01: wire ClaudeProvider
  // as the availability failback for both glm and opr providers. When OpenRouter
  // is unavailable (5xx / timeout / network), the task delegates to Claude with
  // a [GLM FAILBACK] disclosure chunk rather than dying.
  registerGlmProvider({ failbackProviderFactory: () => new ClaudeProvider() });
  registerOprProvider({ failbackProviderFactory: () => new ClaudeProvider() });
  registerOprZeroProvider();
  // WO-HARNESS-GROK-AGENT-PROVIDER-01: tool-capable Grok implement seat (OpenRouter
  // + local tool loop). Chat-only opr must NOT be used for implement.
  registerGrokAgentProvider();
}

/** @internal Test-only -- clears the registry. Not for production use. */
export function clearRegistry(): void {
  registry.clear();
}
