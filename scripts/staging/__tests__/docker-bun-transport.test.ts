import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoots: string[] = [];
const windowsTest = process.platform === 'win32' ? test : test.skip;

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

windowsTest(
  'Invoke-BunScriptInContainer preserves JavaScript quotes across Windows PowerShell',
  async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'staging-bun-transport-'));
    tempRoots.push(tempRoot);
    const stagingData = join(tempRoot, 'staging-data');
    await mkdir(stagingData);

    const fakeDocker = join(tempRoot, 'fake-docker.ps1');
    await writeFile(
      fakeDocker,
      [
        '$all = @($args)',
        'if ($all[0] -eq "inspect") { @(@{ Mounts = @(@{ Source = $env:FAKE_STAGING_DATA; Destination = "/.archon" }) }) | ConvertTo-Json -Depth 3 -Compress; exit 0 }',
        'if ($all.Count -lt 4 -or $all[0] -ne "exec") { throw "missing exec" }',
        '$containerIndex = [Array]::IndexOf($all, "archon-staging")',
        'if ($containerIndex -lt 1) { throw "missing container" }',
        'if ($all[$containerIndex + 1] -ne "bun") { throw "missing bun" }',
        '$containerPath = $all[$containerIndex + 2]',
        '$hostPath = Join-Path $env:FAKE_STAGING_DATA ([IO.Path]::GetFileName($containerPath))',
        '& $env:FAKE_BUN_EXE $hostPath',
        'exit $LASTEXITCODE',
      ].join('\r\n'),
      'ascii'
    );

    const helper = join(import.meta.dir, '..', '_docker-bun.ps1');
    const javascript = 'console.log(JSON.stringify({quoted: "kept", apostrophe: "also-kept"}));';
    const scriptBase64 = Buffer.from(javascript, 'utf8').toString('base64');
    const psScript = [
      '$ErrorActionPreference = "Stop"',
      `. '${helper.replaceAll("'", "''")}'`,
      `$env:FAKE_STAGING_DATA = '${stagingData.replaceAll("'", "''")}'`,
      `$env:FAKE_BUN_EXE = '${process.execPath.replaceAll("'", "''")}'`,
      `$javascript = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${scriptBase64}'))`,
      `$result = Invoke-BunScriptInContainer -Docker '${fakeDocker.replaceAll("'", "''")}' -ContainerName 'archon-staging' -Script $javascript -DockerExecOptions @('-e', 'TEST_FLAG=on')`,
      '$result | ForEach-Object { Write-Output $_ }',
    ].join('\r\n');
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');

    const proc = Bun.spawn(['powershell', '-NoProfile', '-EncodedCommand', encoded], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({
      quoted: 'kept',
      apostrophe: 'also-kept',
    });
    expect(await readdir(stagingData)).toEqual([]);
  }
);

windowsTest('Invoke-BunScriptInContainer removes the temporary file after Bun fails', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'staging-bun-failure-'));
  tempRoots.push(tempRoot);
  const stagingData = join(tempRoot, 'staging-data');
  await mkdir(stagingData);

  const fakeDocker = join(tempRoot, 'fake-docker.ps1');
  await writeFile(
    fakeDocker,
    [
      '$all = @($args)',
      'if ($all[0] -eq "inspect") { @(@{ Mounts = @(@{ Source = $env:FAKE_STAGING_DATA; Destination = "/.archon" }) }) | ConvertTo-Json -Depth 3 -Compress; exit 0 }',
      '$containerIndex = [Array]::IndexOf($all, "archon-staging")',
      '$containerPath = $all[$containerIndex + 2]',
      '$hostPath = Join-Path $env:FAKE_STAGING_DATA ([IO.Path]::GetFileName($containerPath))',
      '& $env:FAKE_BUN_EXE $hostPath',
      'exit $LASTEXITCODE',
    ].join('\r\n'),
    'ascii'
  );

  const helper = join(import.meta.dir, '..', '_docker-bun.ps1');
  const javascript = 'process.exit(7);';
  const scriptBase64 = Buffer.from(javascript, 'utf8').toString('base64');
  const psScript = [
    '$ErrorActionPreference = "Stop"',
    `. '${helper.replaceAll("'", "''")}'`,
    `$env:FAKE_STAGING_DATA = '${stagingData.replaceAll("'", "''")}'`,
    `$env:FAKE_BUN_EXE = '${process.execPath.replaceAll("'", "''")}'`,
    `$javascript = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${scriptBase64}'))`,
    'try {',
    `  Invoke-BunScriptInContainer -Docker '${fakeDocker.replaceAll("'", "''")}' -ContainerName 'archon-staging' -Script $javascript`,
    '  throw "expected helper failure"',
    '} catch {',
    '  Write-Output $_.Exception.Message',
    '}',
  ].join('\r\n');
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');

  const proc = Bun.spawn(['powershell', '-NoProfile', '-EncodedCommand', encoded], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  expect(exitCode, stderr).toBe(0);
  expect(stdout).toContain('container Bun script failed with exit code 7');
  expect(await readdir(stagingData)).toEqual([]);
});

windowsTest('Invoke-BunScriptInContainer rejects non-ASCII scripts before Docker', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'staging-bun-ascii-'));
  tempRoots.push(tempRoot);
  const stagingData = join(tempRoot, 'staging-data');
  await mkdir(stagingData);

  const helper = join(import.meta.dir, '..', '_docker-bun.ps1');
  const psScript = [
    '$ErrorActionPreference = "Stop"',
    `. '${helper.replaceAll("'", "''")}'`,
    '$javascript = [string][char]9731',
    'try {',
    `  Invoke-BunScriptInContainer -Docker 'unused-docker.exe' -ContainerName 'archon-staging' -Script $javascript`,
    '  throw "expected ASCII rejection"',
    '} catch {',
    '  Write-Output $_.Exception.Message',
    '}',
  ].join('\r\n');
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');

  const proc = Bun.spawn(['powershell', '-NoProfile', '-EncodedCommand', encoded], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  expect(exitCode, stderr).toBe(0);
  expect(stdout).toContain('container Bun script must contain ASCII characters only');
  expect(await readdir(stagingData)).toEqual([]);
});

test('staging service canary uses the qualified merge coordinator boundary', async () => {
  const script = await readFile(join(import.meta.dir, '..', 'staging-overseer-safety.ps1'), 'utf8');
  const helper = await readFile(join(import.meta.dir, '..', '_docker-bun.ps1'), 'utf8');

  expect(script).toContain('mergeCoordinator,');
  expect(script).toContain('coordinatorCalls !== 1');
  expect(script).toContain('adapter_attempt_count:' + '" + attempts.length');
  expect(script).not.toContain('actions[0].action !== "fake_merge_attempt"');
  expect(script).toContain('Enabled live Overseer service canary cleanup failed:');
  expect(helper).toContain('container Bun script cleanup left residue:');
  expect(helper).not.toContain(
    'Remove-Item -LiteralPath $hostPath -Force -ErrorAction SilentlyContinue'
  );
});
