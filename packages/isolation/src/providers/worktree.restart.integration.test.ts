import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import type { IsolationRequest } from '../types';
import { WorktreeProvider } from './worktree';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args], { windowsHide: true });
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    const canonicalRepo = join(root, 'canonical');
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', canonicalRepo, 'worktree', 'list', '--porcelain'],
        { windowsHide: true }
      );
      const worktrees = stdout
        .split(/\r?\n/)
        .filter(line => line.startsWith('worktree '))
        .map(line => line.slice('worktree '.length))
        .filter(path => path !== canonicalRepo);
      for (const worktree of worktrees) {
        await execFileAsync(
          'git',
          ['-C', canonicalRepo, 'worktree', 'remove', '--force', worktree],
          {
            windowsHide: true,
          }
        );
      }
    } catch {
      // Setup may have failed before the repository or worktree existed.
    }
    await rm(root, { recursive: true, force: true });
  }
});

describe('WorktreeProvider restart persistence', () => {
  test('a new provider process adopts the same identity without losing uncommitted changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'archon-worktree-restart-'));
    temporaryRoots.push(root);
    const origin = join(root, 'origin.git');
    const canonicalRepo = join(root, 'canonical');

    await mkdir(origin);
    await mkdir(canonicalRepo);
    await execFileAsync('git', ['init', '--bare', origin], { windowsHide: true });
    await git(canonicalRepo, 'init');
    await git(canonicalRepo, 'config', 'user.email', 'cauldron-test@example.invalid');
    await git(canonicalRepo, 'config', 'user.name', 'Cauldron Test');
    await mkdir(join(canonicalRepo, '.archon'));
    await writeFile(join(canonicalRepo, '.archon', 'fixture.txt'), 'fixture\n', 'utf8');
    await writeFile(join(canonicalRepo, 'tracked.txt'), 'committed\n', 'utf8');
    await git(canonicalRepo, 'add', '.archon/fixture.txt', 'tracked.txt');
    await git(canonicalRepo, 'commit', '-m', 'fixture');
    await git(canonicalRepo, 'branch', '-M', 'main');
    await git(canonicalRepo, 'remote', 'add', 'origin', origin);
    await git(canonicalRepo, 'push', '-u', 'origin', 'main');

    const loadConfig = async () => ({
      baseBranch: 'main',
      path: '.worktrees',
      copyFiles: [],
      initSubmodules: false,
    });
    const request: IsolationRequest = {
      codebaseId: 'restart-fixture-codebase',
      canonicalRepoPath: canonicalRepo as IsolationRequest['canonicalRepoPath'],
      workflowType: 'task',
      identifier: 'restart-fixture',
    };

    const firstProcess = new WorktreeProvider(loadConfig);
    const created = await firstProcess.create(request);
    const uncommittedPath = join(created.workingPath, 'survives-restart.txt');
    await writeFile(uncommittedPath, 'uncommitted and preserved\n', 'utf8');

    const restartedProcess = new WorktreeProvider(loadConfig);
    const adopted = await restartedProcess.create(request);

    expect(adopted.id).toBe(created.id);
    expect(adopted.workingPath).toBe(created.workingPath);
    expect(adopted.metadata.adopted).toBe(true);
    expect(await readFile(uncommittedPath, 'utf8')).toBe('uncommitted and preserved\n');
  });
});
