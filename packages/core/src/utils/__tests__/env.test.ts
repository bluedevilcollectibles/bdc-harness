import { describe, it, expect } from 'bun:test';
import { parseEnvFile } from '../env';

describe('parseEnvFile', () => {
  it('parses LF-only content', () => {
    const result = parseEnvFile('FOO=bar\nBAZ=qux\n');
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('parses CRLF content', () => {
    const result = parseEnvFile('FOO=bar\r\nBAZ=qux\r\n');
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('strips UTF-8 BOM prefix', () => {
    const result = parseEnvFile('﻿FOO=bar\nBAZ=qux\n');
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('handles mixed line endings', () => {
    const result = parseEnvFile('A=1\r\nB=2\nC=3\r');
    expect(result).toEqual({ A: '1', B: '2', C: '3' });
  });

  it('strips outer double quotes from values', () => {
    const result = parseEnvFile('KEY="hello world"\n');
    expect(result).toEqual({ KEY: 'hello world' });
  });

  it('strips outer single quotes from values', () => {
    const result = parseEnvFile("KEY='hello world'\n");
    expect(result).toEqual({ KEY: 'hello world' });
  });

  it('does not strip mismatched quotes', () => {
    const result = parseEnvFile('KEY="hello world\'\n');
    expect(result).toEqual({ KEY: '"hello world\'' });
  });

  it('skips blank lines and comment lines', () => {
    const result = parseEnvFile('\n# this is a comment\nFOO=bar\n\nBAZ=qux\n');
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('skips lines without an equals sign', () => {
    const result = parseEnvFile('NOEQUALS\nFOO=bar\n');
    expect(result).toEqual({ FOO: 'bar' });
  });

  it('handles values containing equals signs', () => {
    const result = parseEnvFile('URL=https://example.com?a=1&b=2\n');
    expect(result).toEqual({ URL: 'https://example.com?a=1&b=2' });
  });

  it('returns empty object for empty content', () => {
    expect(parseEnvFile('')).toEqual({});
  });

  it('returns empty object for BOM-only content', () => {
    expect(parseEnvFile('﻿')).toEqual({});
  });

  it('trims trailing whitespace on CRLF values (no carriage return in value)', () => {
    // Simulates the Voice Bridge bug: key=value\r\n where \r would be included in the value
    const result = parseEnvFile('API_KEY=sk-ant-abc123\r\nOTHER=val\r\n');
    expect(result.API_KEY).toBe('sk-ant-abc123');
    expect(result.OTHER).toBe('val');
  });
});
