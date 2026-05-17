import type { WikiFetchResult, OracleFetchResult } from './types';

export function assembleContext(wiki: WikiFetchResult[], oracle: OracleFetchResult[]): string {
  if (wiki.length === 0 && oracle.length === 0) return '';

  const parts: string[] = ['# Loaded context (from persona context:)'];

  for (const w of wiki) {
    parts.push(`\n## Wiki: ${w.path}\n${w.content}`);
  }

  for (const o of oracle) {
    const citationLine = o.citations.length > 0 ? `\n[Citations: ${o.citations.join(', ')}]` : '';
    parts.push(`\n## Oracle: "${o.query}"\n${o.answer}${citationLine}`);
  }

  return parts.join('\n');
}
