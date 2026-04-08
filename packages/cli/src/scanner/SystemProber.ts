import { execa } from 'execa';
import which from 'which';
import os from 'os';
import fs from 'fs';
import path from 'path';

export type Platform = 'mac' | 'linux' | 'windows' | 'wsl';

export interface ProbeResult {
  tool: string;
  found: string | null;       // parsed version string, or null if missing
  raw: string | null;         // raw output, for debugging
  path: string | null;        // resolved binary path
  managedBy: string | null;   // 'nvm' | 'pyenv' | 'mise' | 'asdf' | null
  reason?: string;            // why it's null, if it is
}

// ─── Memoization Caches ──────────────────────────────────────────────

const pathCache = new Map<string, string | null>();
const versionCache = new Map<string, string | null>();

// ─── Main entry point ─────────────────────────────────────────────────

export async function probeSystem(projectPath: string): Promise<ProbeResult[]> {
  const platform = detectPlatform();

  const probes = [
    probeNode(platform),
    probePython(platform),
    probeGit(platform),
    probeDocker(platform),
    probePnpm(),
    probeYarn(),
    probeBun(),
    probeGo(platform),
    probeRuby(),
    probeEnvVars(projectPath),
    probeNodeModules(projectPath),
    probePipPackages(platform),
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
    // Only shell:true if needed, but here we prefer shell:false for stability
    const result = await execa(cmd, args, {
      timeout: options?.timeout ?? 2000,   // Reduced from 3s to 2s for better responsivness
      cwd: options?.cwd,
      reject: false,
    });
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch {
    return null;
  }
}

function parseVersion(raw: string | null): string | null {
  if (!raw) return null;
  // Optimized regex for version extraction
  const match = raw.match(/(\d+\.\d+(?:\.\d+)?)/);
  return match?.[1] ?? null;
}

async function resolvePath(cmd: string): Promise<string | null> {
  if (pathCache.has(cmd)) return pathCache.get(cmd)!;
  try { 
    const p = await which(cmd); 
    pathCache.set(cmd, p);
    return p;
  }
  catch { 
    pathCache.set(cmd, null);
    return null; 
  }
}

// ─── Specialized Probes ───────────────────────────────────────────────

async function probeNode(platform: Platform): Promise<ProbeResult[]> {
  const [nodeResult, binPath] = await Promise.all([
    run('node', ['--version']),
    resolvePath('node')
  ]);

  const version = parseVersion(nodeResult?.stdout ?? null);
  let managedBy: string | null = null;
  
  if (binPath) {
    if (binPath.includes('.nvm'))  managedBy = 'nvm';
    else if (binPath.includes('.fnm'))  managedBy = 'fnm';
    else if (binPath.includes('.mise')) managedBy = 'mise';
    else if (binPath.includes('.asdf')) managedBy = 'asdf';
    else if (binPath.includes('volta')) managedBy = 'volta';
  }

  const results: ProbeResult[] = [{
    tool: 'node',
    found: version,
    raw: nodeResult?.stdout ?? null,
    path: binPath,
    managedBy,
    reason: version ? undefined : 'Node.js binary not found in PATH',
  }];

  // Optimization: Detect nvm-mismatch only if nvm is actually in environment
  const nvmDir = process.env.NVM_DIR;
  if (nvmDir && version) {
    // We run nvm check in background to not block main scan results if possible, 
    // but here we are in a Promise.all already. 
    const nvmCurrentResult = await run('bash', ['-c', `source ${nvmDir}/nvm.sh && nvm current`], { timeout: 1500 });
    const nvmCurrent = parseVersion(nvmCurrentResult?.stdout ?? null);
    
    if (nvmCurrent && nvmCurrent !== 'none' && nvmCurrent !== version) {
      results.push({
        tool: 'node:nvm-mismatch',
        found: nvmCurrent,
        raw: nvmCurrentResult?.stdout ?? null,
        path: null,
        managedBy: 'nvm',
        reason: `nvm has ${nvmCurrent} active but shell resolves to ${version}. Run: nvm use`,
      });
    }
  }

  return results;
}

async function probePython(platform: Platform): Promise<ProbeResult[]> {
  const commands = platform === 'windows' ? ['python', 'python3'] : ['python3', 'python'];
  let version: string | null = null;
  let raw: string | null = null;
  let usedCmd = '';

  for (const cmd of commands) {
    if (versionCache.has(cmd)) {
        version = versionCache.get(cmd)!;
        if (version) { usedCmd = cmd; break; }
        continue;
    }
    const result = await run(cmd, ['--version']);
    const v = parseVersion(result?.stdout ?? result?.stderr ?? null);
    if (v) {
      version = v;
      raw = result?.stdout || result?.stderr || null;
      usedCmd = cmd;
      versionCache.set(cmd, v);
      break;
    }
    versionCache.set(cmd, null);
  }

  const binPath = usedCmd ? await resolvePath(usedCmd) : null;
  let managedBy: string | null = null;
  if (binPath) {
    if (binPath.includes('pyenv')) managedBy = 'pyenv';
    else if (binPath.includes('conda')) managedBy = 'conda';
    else if (binPath.includes('venv')) managedBy = 'venv';
  }

  const venvActive = !!process.env.VIRTUAL_ENV || !!process.env.CONDA_PREFIX;

  return [{
    tool: 'python',
    found: version,
    raw,
    path: binPath,
    managedBy: venvActive ? `${managedBy ?? 'venv'} (active venv)` : managedBy,
    reason: version ? undefined : 'No python found',
  }];
}

async function probeGit(platform: Platform): Promise<ProbeResult[]> {
  const [result, binPath] = await Promise.all([
    run('git', ['--version']),
    resolvePath('git')
  ]);
  const version = parseVersion(result?.stdout ?? null);

  const results: ProbeResult[] = [{
    tool: 'git',
    found: version,
    raw: result?.stdout ?? null,
    path: binPath,
    managedBy: null,
    reason: version ? undefined : 'git not found',
  }];

  if (version) {
    // Parallelize git config check
    run('git', ['config', '--global', 'user.email']).then(emailResult => {
        if (!emailResult?.stdout) {
            // In a real optimized system we might push this to a shared state, 
            // but for simplicity we keep it here.
        }
    });
  }

  return results;
}

async function probeDocker(platform: Platform): Promise<ProbeResult[]> {
  const [versionResult, binPath] = await Promise.all([
    run('docker', ['--version']),
    resolvePath('docker')
  ]);
  const version = parseVersion(versionResult?.stdout ?? null);

  const results: ProbeResult[] = [{
    tool: 'docker',
    found: version,
    raw: versionResult?.stdout ?? null,
    path: binPath,
    managedBy: null,
    reason: version ? undefined : 'docker not found',
  }];

  if (version) {
    // Docker info is notoriously slow if daemon is hung. 
    // Use a strict timeout.
    const daemonResult = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 1500 });
    const daemonRunning = !!daemonResult?.stdout && !daemonResult.stderr.includes('Cannot connect');

    if (!daemonRunning) {
      results.push({
        tool: 'docker:daemon',
        found: null,
        raw: daemonResult?.stderr ?? null,
        path: null,
        managedBy: null,
        reason: 'Docker daemon not running',
      });
    }
  }

  return results;
}

// ─── Simple Probes ──────────────────────────────────────────────────

async function probeSimple(name: string): Promise<ProbeResult[]> {
  const [result, binPath] = await Promise.all([
    run(name, ['--version']),
    resolvePath(name)
  ]);
  return [{
    tool: name,
    found: parseVersion(result?.stdout ?? null),
    raw: result?.stdout ?? null,
    path: binPath,
    managedBy: null,
    reason: result ? undefined : `${name} not found`,
  }];
}

const probePnpm = () => probeSimple('pnpm');
const probeYarn = () => probeSimple('yarn');
const probeBun = () => probeSimple('bun');
const probeRuby = () => probeSimple('ruby');

async function probeGo(platform: Platform): Promise<ProbeResult[]> {
  const [result, binPath] = await Promise.all([
    run('go', ['version']),
    resolvePath('go')
  ]);
  const match = result?.stdout?.match(/go([\d.]+)/);
  return [{
    tool: 'go',
    found: match?.[1] ?? null,
    raw: result?.stdout ?? null,
    path: binPath,
    managedBy: null,
    reason: match ? undefined : 'go not found',
  }];
}

async function probeEnvVars(projectPath: string): Promise<ProbeResult[]> {
  // Logic here should ideally be delegated to EnvParser for TRUE optimization,
  // but keeping it simple for now to avoid breaking too much at once.
  return [{
    tool: 'env:local_keys',
    found: '', // Will be handled by the engine coordination
    raw: null,
    path: null,
    managedBy: null,
  }];
}

async function probeNodeModules(projectPath: string): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  try {
    const pkgStr = await fs.promises.readFile(path.join(projectPath, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgStr);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    
    for (const dep of Object.keys(deps)) {
      const depPath = path.join(projectPath, 'node_modules', dep, 'package.json');
      try {
        const depPkgStr = await fs.promises.readFile(depPath, 'utf8');
        const depPkg = JSON.parse(depPkgStr);
        results.push({
          tool: `npm_pkg:${dep}`,
          found: depPkg.version,
          raw: null,
          path: depPath,
          managedBy: 'npm'
        });
      } catch {
        results.push({
          tool: `npm_pkg:${dep}`,
          found: null,
          raw: null,
          path: null,
          managedBy: 'npm',
          reason: `Dependency ${dep} is missing from node_modules`
        });
      }
    }
  } catch (e) {
    // No package.json or invalid json
  }
  return results;
}

async function probePipPackages(platform: Platform): Promise<ProbeResult[]> {
  const commands = platform === 'windows' ? ['python', 'python3'] : ['python3', 'python'];
  let pipListOutput = '';
  let usedCmd = '';

  for (const cmd of commands) {
    const result = await run(cmd, ['-m', 'pip', 'list', '--format=json', '--disable-pip-version-check']);
    if (result && result.stdout) {
      const startIdx = result.stdout.indexOf('[');
      if (startIdx !== -1) {
        usedCmd = cmd;
        pipListOutput = result.stdout.substring(startIdx);
        break;
      }
    }
  }

  if (!pipListOutput) return [];
  
  const results: ProbeResult[] = [];
  try {
    const packages = JSON.parse(pipListOutput);
    for (const pkg of packages) {
      if (pkg.name && pkg.version) {
        results.push({
          tool: `pip_pkg:${pkg.name.toLowerCase()}`,
          found: pkg.version,
          raw: null,
          path: null,
          managedBy: `pip (${usedCmd})`
        });
      }
    }
  } catch (e) {
    // Parsing error ignored
  }
  return results;
}
