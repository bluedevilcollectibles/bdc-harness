/**
 * Parses the content of a .env file into a key-value map.
 *
 * Handles:
 *   - LF, CRLF, and mixed line endings
 *   - UTF-8 BOM prefix
 *   - Outer single or double quotes on values
 *   - Comments (#) and blank lines (skipped)
 *   - Trailing whitespace on keys and values
 */
export function parseEnvFile(content: string): Record<string, string> {
  // Strip UTF-8 BOM if present
  const stripped = content.startsWith('﻿') ? content.slice(1) : content;

  // Normalize CRLF and CR to LF
  const normalized = stripped.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const result: Record<string, string> = {};

  for (const line of normalized.split('\n')) {
    const trimmed = line.trim();
    // Skip blank lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    if (!key) continue;

    let value = trimmed.slice(eqIdx + 1).trim();

    // Strip surrounding quotes (single or double, must match)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}
