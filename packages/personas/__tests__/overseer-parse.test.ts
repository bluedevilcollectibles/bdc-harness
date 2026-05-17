import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const personaPath = join(import.meta.dir, '..', 'overseer.md');
const content = readFileSync(personaPath, 'utf8');

describe('overseer.md', () => {
  it('is non-empty', () => {
    expect(content.trim().length).toBeGreaterThan(0);
  });

  it('has # Overseer header', () => {
    expect(/^# Overseer$/m.test(content)).toBe(true);
  });

  it('has ## Trigger section', () => {
    expect(/^## Trigger$/m.test(content)).toBe(true);
  });

  it('has ## Failure Classes section', () => {
    expect(/^## Failure Classes$/m.test(content)).toBe(true);
  });

  it('has ## Salvage Playbook section', () => {
    expect(/^## Salvage Playbook$/m.test(content)).toBe(true);
  });

  it('has ## Escalation Criteria section', () => {
    expect(/^## Escalation Criteria$/m.test(content)).toBe(true);
  });

  it('has ## Verification section', () => {
    expect(/^## Verification$/m.test(content)).toBe(true);
  });

  it('documents all 4 failure classes (A through D)', () => {
    expect(content).toContain('Class A');
    expect(content).toContain('Class B');
    expect(content).toContain('Class C');
    expect(content).toContain('Class D');
  });

  it('references the container paths used in production', () => {
    expect(content).toContain('/.archon/workspaces/');
    expect(content).toContain('worktrees/archon/');
  });

  it('references builder monitor post', () => {
    expect(content).toContain('builder-status');
  });
});
