/**
 * Agent persona registry for Cauldron workflows.
 *
 * Loads .archon/agents/*.md files at startup. Each file has YAML frontmatter
 * (name, model, tools, description) plus a Markdown body that becomes the
 * system prompt injected into matching workflow nodes.
 *
 * Validation is fail-closed: any malformed agent file causes the registry load
 * to throw, preventing workflows from firing with a broken persona set.
 */

import { readFile, readdir } from 'fs/promises';
import { join, basename } from 'path';
import { createLogger } from '@archon/paths';
import { KNOWN_TOOLS } from './tools';

/** Lazy-initialized logger */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.agent-registry');
  return cachedLog;
}

/** Structured error codes for agent file validation failures */
export type AgentErrorCode =
  | 'agent_missing_name'
  | 'agent_name_filename_mismatch'
  | 'agent_missing_model'
  | 'agent_invalid_model'
  | 'agent_invalid_tool'
  | 'agent_invalid_context'
  | 'agent_empty_prompt'
  | 'agent_not_found'
  | 'agent_file_read_error';

export class AgentRegistryError extends Error {
  constructor(
    public readonly code: AgentErrorCode,
    public readonly agentFile: string,
    message: string
  ) {
    super(message);
    this.name = 'AgentRegistryError';
  }
}

/** Valid model aliases for agent frontmatter.
 *  These are the Claude model shorthands supported by the Archon harness. */
export const KNOWN_MODEL_ALIASES: ReadonlySet<string> = new Set([
  'sonnet',
  'opus',
  'haiku',
  'opus[1m]',
  'sonnet[1m]',
  // Full model IDs are also accepted
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
]);

/** Context block configuration for a persona (wiki + oracle lookups) */
export interface AgentContext {
  wiki?: string[];
  oracle?: string[];
  ad_hoc?: 'allowed' | 'restricted' | 'denied';
  cache_seconds?: number;
  max_chars?: number;
}

/** Parsed frontmatter from an agent .md file */
export interface AgentFrontmatter {
  name: string;
  // Optional: a `provider: codex` node's persona MUST omit `model:` (the codex
  // SDK rejects Anthropic model names). The registry only validates a model when
  // present; provider-specific required/forbidden enforcement lives in the
  // resolver (resolveAgentPersona in executor-shared.ts), which sees node.provider.
  model?: string;
  tools?: string[];
  description?: string;
  context?: AgentContext;
}

/** A fully loaded and validated agent persona */
export interface AgentPersona {
  name: string;
  model?: string;
  tools?: string[];
  description?: string;
  context?: AgentContext;
  systemPrompt: string;
}

/** In-memory registry mapping agent name → persona */
export type AgentRegistry = Map<string, AgentPersona>;

/**
 * Parse YAML-style frontmatter delimited by `---` lines.
 * Returns `{ frontmatter, body }` where body is everything after the closing `---`.
 *
 * This is a minimal parser that handles only the field types used in agent files:
 * strings, arrays of strings, and optional fields. It does NOT support nested
 * objects. YAML quirks like anchors, aliases, or multi-line scalars are not
 * supported and will be treated as plain strings.
 *
 * Returns `null` if the file does not start with `---\n`.
 */
export function parseFrontmatter(
  content: string
): { frontmatter: Record<string, unknown>; body: string } | null {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return null;

  const afterOpening = content.startsWith('---\r\n') ? content.slice(5) : content.slice(4);
  const closingIdx = afterOpening.search(/^---(\r?\n|$)/m);
  if (closingIdx === -1) return null;

  const fmText = afterOpening.slice(0, closingIdx);
  const closingMatch = /^---(\r?\n|$)/m.exec(afterOpening.slice(closingIdx));
  const bodyStart = closingIdx + (closingMatch?.[0].length ?? 3);
  const body = afterOpening.slice(bodyStart).trim();

  const frontmatter: Record<string, unknown> = {};
  let i = 0;
  const lines = fmText.split(/\r?\n/);

  while (i < lines.length) {
    const line = lines[i];
    if (!line || line.startsWith('#')) {
      i++;
      continue;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    if (rest === '' || rest === null) {
      // Special-case: a blank `model:` scalar (e.g. `model:` with no value) must
      // be recorded as an empty string so the model validator below can fire
      // agent_invalid_model.  Without this, the empty-scalar path never sets
      // frontmatter.model and the validator treats it as "omitted" (valid).
      if (key === 'model') {
        frontmatter[key] = '';
        i++;
        continue;
      }
      // Peek at next line to determine if this is a block sequence or nested object
      const nextLine = lines[i + 1] ?? '';
      if (nextLine.startsWith('  - ')) {
        // Block sequence
        const items: string[] = [];
        i++;
        while (i < lines.length && lines[i]?.startsWith('  - ')) {
          items.push((lines[i] ?? '').slice(4).trim());
          i++;
        }
        if (items.length > 0) {
          frontmatter[key] = items;
        }
      } else if (
        nextLine.startsWith('  ') &&
        nextLine.includes(':') &&
        !nextLine.startsWith('  - ')
      ) {
        // Nested object (2-space indented key: value pairs)
        const obj: Record<string, unknown> = {};
        i++;
        while (i < lines.length) {
          const subLine = lines[i] ?? '';
          if (!subLine.startsWith('  ') || subLine.startsWith('    - ')) {
            // Sub-sequence under nested key
            if (subLine.startsWith('    - ') && Object.keys(obj).length > 0) {
              const lastKey = Object.keys(obj).at(-1);
              if (lastKey === undefined) {
                i++;
                continue;
              }
              if (!Array.isArray(obj[lastKey])) obj[lastKey] = [];
              (obj[lastKey] as string[]).push(subLine.slice(6).trim());
              i++;
              continue;
            }
            break;
          }
          const subColonIdx = subLine.indexOf(':');
          if (subColonIdx === -1) {
            i++;
            continue;
          }
          const subKey = subLine.slice(0, subColonIdx).trim();
          const subRest = subLine.slice(subColonIdx + 1).trim();
          if (subRest === '') {
            // This sub-key might have a block sequence at 4-space indent
            obj[subKey] = [];
            i++;
            while (i < lines.length && (lines[i] ?? '').startsWith('    - ')) {
              (obj[subKey] as string[]).push((lines[i] ?? '').slice(6).trim());
              i++;
            }
          } else {
            // Scalar sub-value — parse as number or string
            const asNum = Number(subRest);
            obj[subKey] = isNaN(asNum) ? subRest.replace(/^["']|["']$/g, '') : asNum;
            i++;
          }
        }
        if (Object.keys(obj).length > 0) {
          frontmatter[key] = obj;
        }
      } else {
        i++;
      }
      continue;
    }

    // Inline sequence: [a, b, c]
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1);
      frontmatter[key] = inner
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      i++;
      continue;
    }

    // Plain scalar — strip optional quotes
    frontmatter[key] = rest.replace(/^["']|["']$/g, '');
    i++;
  }

  return { frontmatter, body };
}

/**
 * Load and validate a single agent .md file.
 * Throws `AgentRegistryError` for any validation failure.
 */
export async function loadAgentFile(filePath: string): Promise<AgentPersona> {
  const filename = basename(filePath, '.md');
  let content: string;

  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    throw new AgentRegistryError(
      'agent_file_read_error',
      filePath,
      `Cannot read agent file '${filePath}': ${(err as Error).message}`
    );
  }

  const parsed = parseFrontmatter(content);
  if (!parsed) {
    throw new AgentRegistryError(
      'agent_missing_name',
      filePath,
      `Agent file '${filePath}' must start with YAML frontmatter (--- ... ---)`
    );
  }

  const { frontmatter, body } = parsed;

  // --- name validation ---
  if (typeof frontmatter.name !== 'string' || !frontmatter.name) {
    throw new AgentRegistryError(
      'agent_missing_name',
      filePath,
      `Agent file '${filePath}' is missing required frontmatter field 'name:' [agent_missing_name]`
    );
  }

  if (frontmatter.name !== filename) {
    throw new AgentRegistryError(
      'agent_name_filename_mismatch',
      filePath,
      `Agent file '${filePath}': frontmatter 'name: ${frontmatter.name}' does not match filename '${filename}' [agent_name_filename_mismatch]`
    );
  }

  // --- model validation ---
  // `model:` is OPTIONAL at the registry layer. A `provider: codex` persona must
  // omit it (the codex SDK cannot serve an Anthropic model alias); a claude
  // persona must declare it. That provider-specific required/forbidden rule is
  // enforced in resolveAgentPersona (executor-shared.ts), which is the only place
  // that knows the node's provider. Here we only reject a model that IS present
  // but is not a known alias.
  if (frontmatter.model !== undefined) {
    if (typeof frontmatter.model !== 'string' || !frontmatter.model) {
      throw new AgentRegistryError(
        'agent_invalid_model',
        filePath,
        `Agent file '${filePath}': 'model:' must be a non-empty string when present [agent_invalid_model]`
      );
    }
    if (!KNOWN_MODEL_ALIASES.has(frontmatter.model)) {
      throw new AgentRegistryError(
        'agent_invalid_model',
        filePath,
        `Agent file '${filePath}': unknown model alias '${frontmatter.model}'. ` +
          `Valid aliases: ${[...KNOWN_MODEL_ALIASES].sort().join(', ')} [agent_invalid_model]`
      );
    }
  }

  // --- tools validation ---
  if (frontmatter.tools !== undefined) {
    if (!Array.isArray(frontmatter.tools)) {
      throw new AgentRegistryError(
        'agent_invalid_tool',
        filePath,
        `Agent file '${filePath}': 'tools:' must be a list of tool names [agent_invalid_tool]`
      );
    }
    for (const tool of frontmatter.tools as string[]) {
      if (!KNOWN_TOOLS.has(tool)) {
        throw new AgentRegistryError(
          'agent_invalid_tool',
          filePath,
          `Agent file '${filePath}': unknown tool '${tool}'. ` +
            `Known tools: ${[...KNOWN_TOOLS].sort().join(', ')} [agent_invalid_tool]`
        );
      }
    }
  }

  // --- context validation ---
  if (frontmatter.context !== undefined) {
    const ctx = frontmatter.context as Record<string, unknown>;

    if (ctx.wiki !== undefined) {
      if (!Array.isArray(ctx.wiki)) {
        throw new AgentRegistryError(
          'agent_invalid_context',
          filePath,
          `Agent file '${filePath}': context.wiki must be a list of paths [agent_invalid_context]`
        );
      }
      for (const p of ctx.wiki as string[]) {
        if (typeof p !== 'string' || !p) {
          throw new AgentRegistryError(
            'agent_invalid_context',
            filePath,
            `Agent file '${filePath}': context.wiki entries must be non-empty strings [agent_invalid_context]`
          );
        }
        if (p.includes('../') || p.startsWith('/')) {
          throw new AgentRegistryError(
            'agent_invalid_context',
            filePath,
            `Agent file '${filePath}': context.wiki path traversal denied: '${p}' [agent_invalid_context]`
          );
        }
        if (/deploy|secrets|credentials/i.test(p)) {
          throw new AgentRegistryError(
            'agent_invalid_context',
            filePath,
            `Agent file '${filePath}': context.wiki forbidden path: '${p}' [agent_invalid_context]`
          );
        }
      }
    }

    if (ctx.oracle !== undefined) {
      if (!Array.isArray(ctx.oracle)) {
        throw new AgentRegistryError(
          'agent_invalid_context',
          filePath,
          `Agent file '${filePath}': context.oracle must be a list of query strings [agent_invalid_context]`
        );
      }
      for (const q of ctx.oracle as string[]) {
        if (typeof q !== 'string' || !q) {
          throw new AgentRegistryError(
            'agent_invalid_context',
            filePath,
            `Agent file '${filePath}': context.oracle entries must be non-empty strings [agent_invalid_context]`
          );
        }
      }
    }

    if (ctx.ad_hoc !== undefined) {
      if (!['allowed', 'restricted', 'denied'].includes(ctx.ad_hoc as string)) {
        throw new AgentRegistryError(
          'agent_invalid_context',
          filePath,
          `Agent file '${filePath}': context.ad_hoc must be 'allowed', 'restricted', or 'denied' [agent_invalid_context]`
        );
      }
    }

    if (ctx.cache_seconds !== undefined) {
      if (
        typeof ctx.cache_seconds !== 'number' ||
        ctx.cache_seconds <= 0 ||
        !Number.isInteger(ctx.cache_seconds)
      ) {
        throw new AgentRegistryError(
          'agent_invalid_context',
          filePath,
          `Agent file '${filePath}': context.cache_seconds must be a positive integer [agent_invalid_context]`
        );
      }
    }

    if (ctx.max_chars !== undefined) {
      if (
        typeof ctx.max_chars !== 'number' ||
        ctx.max_chars <= 0 ||
        !Number.isInteger(ctx.max_chars)
      ) {
        throw new AgentRegistryError(
          'agent_invalid_context',
          filePath,
          `Agent file '${filePath}': context.max_chars must be a positive integer [agent_invalid_context]`
        );
      }
    }
  }

  // --- body (system prompt) validation ---
  if (!body) {
    throw new AgentRegistryError(
      'agent_empty_prompt',
      filePath,
      `Agent file '${filePath}' has no system prompt body (content after frontmatter is empty) [agent_empty_prompt]`
    );
  }

  const persona: AgentPersona = {
    name: frontmatter.name,
    model: frontmatter.model,
    systemPrompt: body,
  };

  if (Array.isArray(frontmatter.tools) && (frontmatter.tools as string[]).length > 0) {
    persona.tools = frontmatter.tools as string[];
  }
  if (typeof frontmatter.description === 'string' && frontmatter.description) {
    persona.description = frontmatter.description;
  }
  if (frontmatter.context !== undefined) {
    const ctx = frontmatter.context as Record<string, unknown>;
    persona.context = {
      ...(ctx.wiki !== undefined && { wiki: ctx.wiki as string[] }),
      ...(ctx.oracle !== undefined && { oracle: ctx.oracle as string[] }),
      ...(ctx.ad_hoc !== undefined && {
        ad_hoc: ctx.ad_hoc as 'allowed' | 'restricted' | 'denied',
      }),
      ...(ctx.cache_seconds !== undefined && { cache_seconds: ctx.cache_seconds as number }),
      ...(ctx.max_chars !== undefined && { max_chars: ctx.max_chars as number }),
    };
  }

  return persona;
}

/**
 * Load all agent persona files from a directory (non-recursive, *.md only).
 * Returns the populated registry.
 *
 * Throws `AgentRegistryError` for the first invalid file encountered — the
 * registry is all-or-nothing: a single malformed file prevents startup.
 *
 * Returns an empty registry if the directory does not exist (no agents configured).
 */
export async function loadAgentRegistry(agentsDir: string): Promise<AgentRegistry> {
  const registry: AgentRegistry = new Map();

  let entries: string[];
  try {
    entries = await readdir(agentsDir);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') {
      // No agents directory — return empty registry (agents are optional)
      return registry;
    }
    throw new AgentRegistryError(
      'agent_file_read_error',
      agentsDir,
      `Cannot read agents directory '${agentsDir}': ${nodeErr.message}`
    );
  }

  const mdFiles = entries.filter(e => e.endsWith('.md')).sort();

  for (const filename of mdFiles) {
    const filePath = join(agentsDir, filename);
    const persona = await loadAgentFile(filePath);
    registry.set(persona.name, persona);
    getLog().info(
      { name: persona.name, model: persona.model, tools: persona.tools },
      'agent.loaded'
    );
  }

  getLog().info({ count: registry.size }, 'agent.registry_loaded');
  return registry;
}

/**
 * Resolve an agent name to its persona from the registry.
 * Returns `undefined` if the registry is empty (no agents dir configured).
 * Throws `AgentRegistryError` with code `agent_not_found` if the registry was
 * loaded but the name is absent.
 */
export function resolveAgent(name: string, registry: AgentRegistry): AgentPersona | undefined {
  if (registry.size === 0) return undefined;

  const persona = registry.get(name);
  if (!persona) {
    throw new AgentRegistryError(
      'agent_not_found',
      name,
      `Agent '${name}' not found in registry. Available: ${[...registry.keys()].sort().join(', ')} [agent_not_found]`
    );
  }
  return persona;
}
