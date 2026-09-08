/**
 * Scenario A2 (WO-HARNESS-M131-PHASE-A-GROK-SEAT-PROOF-01): seat isolation
 * and honesty, proven statically and hermetically. Reads the seat packaging
 * files as text/YAML with synthetic placeholders only -- no docker daemon,
 * no live host, no credential.
 *
 * Fails on: root execution, a writable secret ingress, a shared
 * home/profile, more than one refresh writer, an extra provider, or missing
 * build-SHA wiring.
 */
import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'path';
import { parse } from 'yaml';

const dir = import.meta.dir;
const dockerfile = await Bun.file(join(dir, 'Dockerfile')).text();
const composeRaw = await Bun.file(join(dir, 'docker-compose.example.yml')).text();
const seatConfig = (await Bun.file(join(dir, 'config.seat.example.json')).json()) as {
  seat: {
    seat_id: string;
    provider_allowlist: string[];
    secret_ingress_file: string;
    vendor_profile_dir: string;
    state_dir: string;
    build_sha_env: string;
  };
  agents?: Record<string, unknown>;
  max_concurrency: Record<string, number>;
};

interface ComposeService {
  user?: string;
  environment?: Record<string, string>;
  volumes: string[];
  healthcheck?: { test: string[] };
  build?: { args?: Record<string, string> };
}
const compose = parse(composeRaw) as {
  services: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
};
const service = compose.services['bdc-seat-grok'] as ComposeService;

describe('m131-seat Dockerfile contract', () => {
  test('runs as a named non-root user', () => {
    expect(dockerfile).toMatch(/^USER seat$/m);
    expect(dockerfile).toMatch(/--uid 10001/);
    expect(dockerfile).not.toMatch(/^USER root$/m);
  });

  test('wires the exact build SHA from build arg to runtime env', () => {
    expect(dockerfile).toMatch(/^ARG BUILD_SHA/m);
    expect(dockerfile).toMatch(/^ENV SEAT_BUILD_SHA=\$\{BUILD_SHA\}$/m);
  });

  // REGRESSION (review finding 2026-08-17): BUILD_SHA defaulted to 'unknown',
  // letting a seat advertise an identity it did not have.
  test('BUILD_SHA has NO placeholder default and the build fails without it', () => {
    expect(dockerfile).not.toMatch(/^ARG BUILD_SHA=/m);
    expect(dockerfile).toMatch(/test -n "\$\{BUILD_SHA\}"/);
  });

  test('healthcheck is the sanitized seat preflight instrument', () => {
    expect(dockerfile).toMatch(/^HEALTHCHECK/m);
    expect(dockerfile).toContain('scripts/dispatch-worker/seat-preflight.ts');
  });

  // REGRESSION (bdc-xo#1813): the image copied only the root package.json and
  // bun.lock, but the root package.json declares workspaces: [packages/*] and
  // the monorepo lockfile depends on every workspace manifest. bun install
  // --frozen-lockfile therefore failed and the image never built from a clean
  // clone. Derived from the tree, not a hardcoded list, so adding a workspace
  // package without updating the Dockerfile fails here rather than in a build.
  test('copies every workspace package.json before bun install', async () => {
    const repoRoot = join(dir, '..', '..');
    const workspaces: string[] = [];
    for (const entry of await readdir(join(repoRoot, 'packages'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (await Bun.file(join(repoRoot, 'packages', entry.name, 'package.json')).exists()) {
        workspaces.push(entry.name);
      }
    }
    expect(workspaces.length).toBeGreaterThan(1);

    // Anchor on the RUN instruction itself, not prose mentioning bun install.
    const installMatch = /^RUN bun install .*$/m.exec(dockerfile);
    expect(installMatch).not.toBeNull();
    const beforeInstall = dockerfile.slice(0, installMatch!.index);
    for (const name of workspaces) {
      expect(beforeInstall).toContain(`packages/${name}/package.json`);
    }
  });

  // REGRESSION (bdc-xo#1813): the image installed no provider CLI at all.
  // seat-preflight resolves the provider command with Bun.which(), so every
  // seat failed closed at seat_provider_command_unavailable and no board seat
  // could run anywhere but the operator desktop.
  test('installs the grok provider CLI at a pinned version', () => {
    expect(dockerfile).toMatch(/^ARG GROK_VERSION=\d+\.\d+\.\d+$/m);
    expect(dockerfile).toContain('/usr/local/bin/grok');
    // Pinned, never an implicit "latest": the URL must carry the version.
    expect(dockerfile).toContain('grok-${GROK_VERSION}-linux-');
    // The build proves the CLI works rather than trusting the download.
    expect(dockerfile).toContain('grok agent stdio --help');
  });

  // The image must stay credential-free: credentials arrive at RUN time by
  // bind mount / env, exactly as archon-app-1 does it today. In particular the
  // vendor installer is not piped to a shell -- it reads ~/.grok/auth.json and
  // writes a proxy auth header.
  test('bakes no credential into the image', () => {
    expect(dockerfile).not.toMatch(/x\.ai\/cli\/install\.sh/);
    expect(dockerfile).not.toMatch(/GROK_DEPLOYMENT_KEY/);
    expect(dockerfile).not.toMatch(/XAI_API_KEY\s*=/);
    expect(dockerfile).not.toMatch(/^ENV\s+\w*(API_KEY|TOKEN|SECRET)\w*=/m);
  });
});

describe('m131-seat compose contract', () => {
  test('service exists and runs non-root', () => {
    expect(service).toBeDefined();
    expect(service.user).toBe('10001:10001');
  });

  test('exactly one read-only secret-ingress file mount', () => {
    const ingress = service.volumes.filter(volume => volume.includes('/run/m131/secret-ingress/'));
    expect(ingress).toHaveLength(1);
    expect(ingress[0]).toEndWith(':ro');
  });

  test('seat-private writable vendor profile is a distinct named volume', () => {
    const profile = service.volumes.filter(volume =>
      volume.startsWith('m131-grok-vendor-profile:')
    );
    expect(profile).toHaveLength(1);
    expect(profile[0]).not.toEndWith(':ro');
    expect(compose.volumes).toHaveProperty('m131-grok-vendor-profile');
  });

  test('separate non-secret state volume, distinct from the vendor profile', () => {
    const state = service.volumes.filter(volume => volume.startsWith('m131-grok-state:'));
    expect(state).toHaveLength(1);
    expect(compose.volumes).toHaveProperty('m131-grok-state');
    const profileTarget = 'm131-grok-vendor-profile';
    expect(state[0]).not.toContain(profileTarget);
    const stateTarget = state[0]?.split(':')[1];
    const vendorTarget = service.volumes
      .find(volume => volume.startsWith(`${profileTarget}:`))
      ?.split(':')[1];
    expect(stateTarget).toBeDefined();
    expect(vendorTarget).toBeDefined();
    expect(stateTarget).not.toBe(vendorTarget);
  });

  test('no shared home: only this seat mounts the vendor profile home path', () => {
    expect(Object.keys(compose.services)).toEqual(['bdc-seat-grok']);
    const homeMounts = service.volumes.filter(volume => volume.includes('/home/seat/.grok'));
    expect(homeMounts).toHaveLength(1);
  });

  test('build SHA flows from compose arg to the running environment', () => {
    expect(service.build?.args?.BUILD_SHA).toContain('BUILD_SHA');
    expect(service.environment?.SEAT_BUILD_SHA).toContain('BUILD_SHA');
  });

  test('compose REQUIRES BUILD_SHA rather than defaulting to a placeholder', () => {
    // `${BUILD_SHA:?...}` is compose's required-variable form; `:-unknown`
    // would silently substitute a placeholder.
    expect(composeRaw).not.toContain('BUILD_SHA:-unknown');
    expect(composeRaw).toContain('BUILD_SHA:?');
  });

  test('healthcheck uses the seat preflight instrument', () => {
    expect(service.healthcheck?.test.join(' ')).toContain(
      'scripts/dispatch-worker/seat-preflight.ts'
    );
  });
});

describe('m131-seat config contract', () => {
  test('advertises only Grok, concurrency one', () => {
    expect(seatConfig.seat.provider_allowlist).toEqual(['grok-acp']);
    expect(seatConfig.agents ?? {}).toEqual({});
    expect(seatConfig.max_concurrency).toEqual({ 'grok-acp': 1 });
  });

  test('seat paths match the compose mount targets and stay isolated', () => {
    expect(seatConfig.seat.secret_ingress_file).toBe(
      '/run/m131/secret-ingress/grok-credential.json'
    );
    expect(seatConfig.seat.vendor_profile_dir).toBe('/home/seat/.grok');
    expect(seatConfig.seat.state_dir).toBe('/var/lib/bdc-seat');
    expect(seatConfig.seat.state_dir).not.toBe(seatConfig.seat.vendor_profile_dir);
    expect(seatConfig.seat.build_sha_env).toBe('SEAT_BUILD_SHA');
  });
});

describe('no literal secret in seat packaging', () => {
  const files = { dockerfile, composeRaw, seatConfig: JSON.stringify(seatConfig) };
  const secretPatterns = [
    /xai-[A-Za-z0-9]{10,}/,
    /sk-[A-Za-z0-9]{10,}/,
    /AKIA[0-9A-Z]{16}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /(password|secret|token)\s*[=:]\s*['"][^'"$/{][^'"]{7,}['"]/i,
  ];
  for (const [name, content] of Object.entries(files)) {
    test(`${name} carries no credential material`, () => {
      for (const pattern of secretPatterns) {
        expect(content).not.toMatch(pattern);
      }
    });
  }
});
