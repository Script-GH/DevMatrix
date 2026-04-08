import { execa, ExecaError } from 'execa';
import which from 'which';
import os from 'os';
import fs from 'fs';

export type Platform = 'mac' | 'linux' | 'windows' | 'wsl';

export interface ProbeResult {
  tool: string;
  found: string | null;       // parsed version string, or null if missing
  raw: string | null;         // raw output, for debugging
  path: string | null;        // resolved binary path
  managedBy: string | null;   // 'nvm' | 'pyenv' | 'mise' | 'asdf' | null
  reason?: string;            // why it's null, if it is
}

// ─── Main entry point ─────────────────────────────────────────────────

export async function probeSystem(projectPath: string): Promise<ProbeResult[]> {
  const platform = detectPlatform();

  const probes = [
    probeNode(platform),
    probePython(platform),
    probeGit(platform),
    probeDocker(platform),
    probePnpm(platform),
    probeYarn(platform),
    probeBun(platform),
    probeGo(platform),
    probeRuby(platform),
    probeEnvVars(projectPath),
  ];

  const results = await Promise.allSettled(probes);
  return results.map(r =>
    r.status === 'fulfilled'
      ? r.value
      : [{ tool: 'unknown', found: null, raw: null, path: null, managedBy: null, reason: String(r.reason) }]
  ).flat();
}

// ─── Platform detection ───────────────────────────────────────────────

export function detectPlatform(): Platform {
  if (os.platform() === 'win32') return 'windows';
  if (os.platform() === 'darwin') return 'mac';
  // Detect WSL: Linux kernel but with Windows filesystem mounted
  try {
    const release = fs.readFileSync('/proc/version', 'utf8');
    if (release.toLowerCase().includes('microsoft')) return 'wsl';
  } catch {}
  return 'linux';
}

// ─── Core probe primitive ─────────────────────────────────────────────

async function run(
  cmd: string,
  args: string[],
  options?: { timeout?: number; cwd?: string }
): Promise<{ stdout: string; stderr: string } | null> {
  try {
    const result = await execa(cmd, args, {
      timeout: options?.timeout ?? 3000,   // 3s kill switch
      cwd: options?.cwd,
      reject: false,                        // never throw on non-zero exit
      shell: false,                         // never use shell — avoids injection and PATH weirdness
    });
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (e) {
    // timeout or binary not found
    return null;
  }
}

// Extract semver from messy output like "Python 3.11.6" or "git version 2.44.0"
function parseVersion(raw: string | null): string | null {
  if (!raw) return null;
  const match = raw.match(/(\d+\.\d+[\.\d]*)/);
  return match?.[1] ?? null;
}

async function resolvePath(cmd: string): Promise<string | null> {
  try { return await which(cmd); }
  catch { return null; }
}

// ─── Node.js probe ────────────────────────────────────────────────────

async function probeNode(platform: Platform): Promise<ProbeResult[]> {
  const result = await run('node', ['--version']);
  const version = parseVersion(result?.stdout ?? null);
  const binPath = await resolvePath('node');

  // Detect version manager from binary path
  let managedBy: string | null = null;
  if (binPath) {
    if (binPath.includes('.nvm'))  managedBy = 'nvm';
    if (binPath.includes('.fnm'))  managedBy = 'fnm';
    if (binPath.includes('.mise')) managedBy = 'mise';
    if (binPath.includes('.asdf')) managedBy = 'asdf';
    if (binPath.includes('volta')) managedBy = 'volta';
  }

  // Also check if nvm is available but not activated
  // This is the "nvm installed but node resolves to system" trap
  const nvmDir = process.env.NVM_DIR;
  const nvmCurrentResult = nvmDir
    ? await run('bash', ['-c', `source ${nvmDir}/nvm.sh && nvm current`])
    : null;
  const nvmCurrent = parseVersion(nvmCurrentResult?.stdout ?? null);

  const probeResult: ProbeResult = {
    tool: 'node',
    found: version,
    raw: result?.stdout ?? null,
    path: binPath,
    managedBy,
    reason: version ? undefined : 'Node.js binary not found in PATH',
  };

  const results: ProbeResult[] = [probeResult];

  // Flag the nvm-installed-but-wrong-version trap
  if (nvmCurrent && version && nvmCurrent !== 'none' && nvmCurrent !== version) {
    results.push({
      tool: 'node:nvm-mismatch',
      found: nvmCurrent,
      raw: nvmCurrentResult?.stdout ?? null,
      path: null,
      managedBy: 'nvm',
      reason: `nvm has ${nvmCurrent} active but shell resolves to ${version}. Run: nvm use`,
    });
  }

  return results;
}

// ─── Python probe ─────────────────────────────────────────────────────

async function probePython(platform: Platform): Promise<ProbeResult[]> {
  // Try python3 first, then python — order matters on Linux
  const commands = platform === 'windows'
    ? ['python', 'python3']
    : ['python3', 'python'];

  let version: string | null = null;
  let raw: string | null = null;
  let usedCmd = '';

  for (const cmd of commands) {
    const result = await run(cmd, ['--version']);
    const v = parseVersion(result?.stdout ?? result?.stderr ?? null);
    // Note: Python 2 prints to stderr! Handle both.
    if (v) {
      version = v;
      raw = result?.stdout || result?.stderr || null;
      usedCmd = cmd;
      break;
    }
  }

  const binPath = usedCmd ? await resolvePath(usedCmd) : null;

  let managedBy: string | null = null;
  if (binPath) {
    if (binPath.includes('pyenv'))  managedBy = 'pyenv';
    if (binPath.includes('.mise'))  managedBy = 'mise';
    if (binPath.includes('.asdf'))  managedBy = 'asdf';
    if (binPath.includes('conda'))  managedBy = 'conda';
    if (binPath.includes('venv'))   managedBy = 'venv';
    if (binPath.includes('miniforge') || binPath.includes('mambaforge')) managedBy = 'conda';
  }

  // Detect virtual environment
  const venvActive = !!process.env.VIRTUAL_ENV || !!process.env.CONDA_PREFIX;

  return [{
    tool: 'python',
    found: version,
    raw,
    path: binPath,
    managedBy: venvActive ? `${managedBy ?? 'venv'} (active venv)` : managedBy,
    reason: version ? undefined : 'No python3 or python binary found in PATH',
  }];
}

// ─── Git probe ────────────────────────────────────────────────────────

async function probeGit(platform: Platform): Promise<ProbeResult[]> {
  const result = await run('git', ['--version']);
  // Output: "git version 2.44.0" or "git version 2.44.0.windows.1"
  const version = parseVersion(result?.stdout ?? null);
  const binPath = await resolvePath('git');

  // Extra: check if git config has user.email set (needed for commits)
  const emailResult = await run('git', ['config', '--global', 'user.email']);
  const hasEmail = !!emailResult?.stdout;

  const results: ProbeResult[] = [{
    tool: 'git',
    found: version,
    raw: result?.stdout ?? null,
    path: binPath,
    managedBy: null,
    reason: version ? undefined : 'git not found',
  }];

  if (version && !hasEmail) {
    results.push({
      tool: 'git:config',
      found: null,
      raw: null,
      path: null,
      managedBy: null,
      reason: 'git user.email not configured — commits will fail',
    });
  }

  return results;
}

// ─── Docker probe ─────────────────────────────────────────────────────

async function probeDocker(platform: Platform): Promise<ProbeResult[]> {
  const versionResult = await run('docker', ['--version']);
  const version = parseVersion(versionResult?.stdout ?? null);

  // Separate check: is the Docker daemon actually running?
  // "docker --version" succeeds even when daemon is stopped
  const daemonResult = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 4000 });
  const daemonRunning = !!daemonResult?.stdout && (daemonResult?.stderr ?? '').indexOf('Cannot connect') === -1;

  const results: ProbeResult[] = [{
    tool: 'docker',
    found: version,
    raw: versionResult?.stdout ?? null,
    path: await resolvePath('docker'),
    managedBy: null,
    reason: version ? undefined : 'docker CLI not found',
  }];

  // Docker installed but daemon not running is a very common gotcha
  if (version && !daemonRunning) {
    results.push({
      tool: 'docker:daemon',
      found: null,
      raw: daemonResult?.stderr ?? null,
      path: null,
      managedBy: null,
      reason: 'Docker installed but daemon is not running — start Docker Desktop',
    });
  }

  return results;
}

// ─── Package manager probes ───────────────────────────────────────────

async function probePnpm(platform: Platform): Promise<ProbeResult[]> {
  const result = await run('pnpm', ['--version']);
  return [{
    tool: 'pnpm',
    found: parseVersion(result?.stdout ?? null),
    raw: result?.stdout ?? null,
    path: await resolvePath('pnpm'),
    managedBy: null,
    reason: result ? undefined : 'pnpm not installed — run: npm install -g pnpm',
  }];
}

async function probeYarn(platform: Platform): Promise<ProbeResult[]> {
  const result = await run('yarn', ['--version']);
  return [{
    tool: 'yarn',
    found: parseVersion(result?.stdout ?? null),
    raw: result?.stdout ?? null,
    path: await resolvePath('yarn'),
    managedBy: null,
    reason: result ? undefined : 'yarn not found',
  }];
}

async function probeBun(platform: Platform): Promise<ProbeResult[]> {
  const result = await run('bun', ['--version']);
  return [{
    tool: 'bun',
    found: parseVersion(result?.stdout ?? null),
    raw: result?.stdout ?? null,
    path: await resolvePath('bun'),
    managedBy: null,
    reason: result ? undefined : 'bun not found',
  }];
}

async function probeGo(platform: Platform): Promise<ProbeResult[]> {
  const result = await run('go', ['version']);
  // Output: "go version go1.22.0 darwin/arm64"
  const match = result?.stdout?.match(/go([\d.]+)/);
  return [{
    tool: 'go',
    found: match?.[1] ?? null,
    raw: result?.stdout ?? null,
    path: await resolvePath('go'),
    managedBy: null,
    reason: match ? undefined : 'go not found',
  }];
}

async function probeRuby(platform: Platform): Promise<ProbeResult[]> {
  const result = await run('ruby', ['--version']);
  return [{
    tool: 'ruby',
    found: parseVersion(result?.stdout ?? null),
    raw: result?.stdout ?? null,
    path: await resolvePath('ruby'),
    managedBy: null,
    reason: result ? undefined : 'ruby not found',
  }];
}

// ─── Environment variable probe ───────────────────────────────────────

async function probeEnvVars(projectPath: string): Promise<ProbeResult[]> {
  // Read the actual .env file if it exists (never committed, but present locally)
  const envPath = `${projectPath}/.env`;
  let localEnvKeys = new Set<string>();

  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      if (line.trim() && !line.startsWith('#')) {
        const key = line.split('=')[0].trim();
        if (key) localEnvKeys.add(key);
      }
    }
  } catch {
    // .env doesn't exist — all keys will be checked against process.env only
  }

  // Passing local keys back as a special 'env:local_keys' probe result
  return [{
    tool: 'env:local_keys',
    found: Array.from(localEnvKeys).join(','),
    raw: null,
    path: null,
    managedBy: null,
  }];
}
