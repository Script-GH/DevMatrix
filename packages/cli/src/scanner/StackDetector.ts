import fs from 'fs/promises';
import path from 'path';
import { parse as parseToml } from '@iarna/toml';

export interface StackRequirement {
  tool: string;
  required: string | null;
  source: string;          // which file this came from
  rangeType: 'exact' | 'semver-range' | 'min' | 'unknown';
}

// ─── Caches ─────────────────────────────────────────────────────────
const fileCache = new Map<string, string>();

async function cachedReadFile(filePath: string): Promise<string> {
    if (fileCache.has(filePath)) return fileCache.get(filePath)!;
    const content = await fs.readFile(filePath, 'utf8');
    fileCache.set(filePath, content);
    return content;
}

export async function detectStack(projectPath: string): Promise<StackRequirement[]> {
  const requirements: StackRequirement[] = [];
  
  // 1. Discovery phase: Find all relevant directories
  const pathsToScan = [projectPath];
  const dirEntries = new Map<string, string[]>();

  try {
    const rootEntries = await fs.readdir(projectPath, { withFileTypes: true });
    dirEntries.set(projectPath, rootEntries.map(e => e.name));

    const subdirs = rootEntries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => path.join(projectPath, e.name));
    
    pathsToScan.push(...subdirs);

    // Populate dirEntries for subdirs
    await Promise.all(subdirs.map(async (sd) => {
        try {
            const entries = await fs.readdir(sd);
            dirEntries.set(sd, entries);
        } catch {
            dirEntries.set(sd, []);
        }
    }));
  } catch (e) {
    dirEntries.set(projectPath, []);
  }

  // 2. Intelligent scan: Only run readers if their trigger files exist
  const tasks: Promise<StackRequirement[]>[] = [];

  for (const dir of pathsToScan) {
    const files = dirEntries.get(dir) || [];
    
    if (files.includes('.tool-versions')) tasks.push(readToolVersions(dir));
    if (files.includes('.nvmrc')) tasks.push(readNvmrc(dir));
    if (files.includes('package.json')) tasks.push(readPackageJson(dir));
    if (files.includes('pyproject.toml')) tasks.push(readPyprojectToml(dir));
    if (files.includes('go.mod')) tasks.push(readGoMod(dir));
    if (files.includes('Dockerfile')) tasks.push(readDockerfile(dir));
    if (files.includes('.env.example') || files.includes('.env.template')) tasks.push(readEnvExample(dir));
    if (files.includes('requirements.txt')) tasks.push(readRequirementsTxt(dir));
    if (files.some(f => f.endsWith('.java') || f === 'pom.xml' || f.startsWith('build.gradle'))) tasks.push(readJava(dir));
    
    tasks.push(readExtendedHeuristics(dir, files));
  }

  const results = await Promise.allSettled(tasks);

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.length > 0) {
      requirements.push(...result.value);
    }
  }

  return deduplicateAndPrioritize(requirements, projectPath);
}

// ─── Individual readers ───────────────────────────────────────────────

async function readNvmrc(root: string): Promise<StackRequirement[]> {
  const content = await cachedReadFile(path.join(root, '.nvmrc'));
  const raw = content.trim();
  const version = resolveLtsAlias(raw) ?? normalizeVersion(raw);
  return [{ tool: 'node', required: version, source: formatSource(root, '.nvmrc'), rangeType: 'exact' }];
}

async function readPackageJson(root: string): Promise<StackRequirement[]> {
  const content = await cachedReadFile(path.join(root, 'package.json'));
  const pkg = JSON.parse(content);
  const reqs: StackRequirement[] = [];

  reqs.push({
    tool: 'node',
    required: pkg.engines?.node ?? null,
    source: formatSource(root, 'package.json'),
    rangeType: pkg.engines?.node ? 'semver-range' : 'unknown'
  });

  if (pkg.engines?.npm) {
    reqs.push({
      tool: 'npm',
      required: pkg.engines.npm,
      source: formatSource(root, 'package.json#engines.npm'),
      rangeType: 'semver-range'
    });
  }
  if (pkg.packageManager) {
    const [manager, version] = pkg.packageManager.split('@');
    reqs.push({
      tool: manager,
      required: version ?? null,
      source: formatSource(root, 'package.json#packageManager'),
      rangeType: version ? 'exact' : 'unknown'
    });
  }
  if (pkg.dependencies) {
    for (const [dep, version] of Object.entries(pkg.dependencies)) {
      reqs.push({
        tool: `npm_pkg:${dep}`,
        required: version as string,
        source: formatSource(root, 'package.json#dependencies'),
        rangeType: 'semver-range'
      });
    }
  }
  if (pkg.devDependencies) {
    for (const [dep, version] of Object.entries(pkg.devDependencies)) {
      reqs.push({
        tool: `npm_pkg:${dep}`,
        required: version as string,
        source: formatSource(root, 'package.json#devDependencies'),
        rangeType: 'semver-range'
      });
    }
  }

  return reqs;
}

async function readToolVersions(root: string): Promise<StackRequirement[]> {
  const content = await cachedReadFile(path.join(root, '.tool-versions'));
  return content
    .split('\n')
    .filter(line => line.trim() && !line.startsWith('#'))
    .map(line => {
      const [tool, version] = line.trim().split(/\s+/);
      const normalizedTool = tool === 'nodejs' ? 'node' : tool;
      return {
        tool: normalizedTool,
        required: version ?? null,
        source: formatSource(root, '.tool-versions'),
        rangeType: 'exact' as const
      };
    });
}

async function readPyprojectToml(root: string): Promise<StackRequirement[]> {
  const content = await cachedReadFile(path.join(root, 'pyproject.toml'));
  const parsed = parseToml(content) as any;
  const reqs: StackRequirement[] = [];

  const requiresPython = parsed?.project?.['requires-python'] || parsed?.tool?.poetry?.dependencies?.python;
  if (requiresPython) {
    reqs.push({
      tool: 'python',
      required: requiresPython,
      source: formatSource(root, 'pyproject.toml'),
      rangeType: 'semver-range'
    });
  } else {
    reqs.push({
      tool: 'python',
      required: null,
      source: formatSource(root, 'pyproject.toml'),
      rangeType: 'unknown'
    });
  }

  const poetryDeps = parsed?.tool?.poetry?.dependencies;
  if (poetryDeps) {
      for (const [dep, version] of Object.entries(poetryDeps)) {
          if (dep.toLowerCase() === 'python') continue;
          reqs.push({
              tool: `pip_pkg:${dep.toLowerCase()}`,
              required: typeof version === 'string' ? version : (version as any).version || '*',
              source: formatSource(root, 'pyproject.toml#poetry'),
              rangeType: 'semver-range'
          });
      }
  }

  const projectDeps = parsed?.project?.dependencies;
  if (Array.isArray(projectDeps)) {
      for (const depStr of projectDeps) {
          const match = depStr.match(/^([a-zA-Z0-9_-]+)(.*?)$/);
          if (match) {
              const dep = match[1].toLowerCase();
              const version = match[2].trim() || '*';
              reqs.push({
                  tool: `pip_pkg:${dep}`,
                  required: version,
                  source: formatSource(root, 'pyproject.toml'),
                  rangeType: 'semver-range'
              });
          }
      }
  }

  return reqs;
}

async function readRequirementsTxt(root: string): Promise<StackRequirement[]> {
  const content = await cachedReadFile(path.join(root, 'requirements.txt'));
  const reqs: StackRequirement[] = [];
  
  for (const line of content.split('\n')) {
    const clean = line.split('#')[0].trim();
    if (!clean) continue;
    const match = clean.match(/^([a-zA-Z0-9_-]+)(.*)$/);
    if (match) {
        reqs.push({
            tool: `pip_pkg:${match[1].toLowerCase()}`,
            required: match[2].trim() || '*',
            source: formatSource(root, 'requirements.txt'),
            rangeType: 'semver-range'
        });
    }
  }
  return reqs;
}

async function readEnvExample(root: string): Promise<StackRequirement[]> {
  let content: string;
  let sourceFile = '.env.example';
  try {
    content = await cachedReadFile(path.join(root, '.env.example'));
  } catch {
    content = await cachedReadFile(path.join(root, '.env.template'));
    sourceFile = '.env.template';
  }

  return content
    .split('\n')
    .filter(line => line.trim() && !line.startsWith('#'))
    .map(line => {
      const key = line.split('=')[0].trim();
      if (!key) return null!;
      return {
        tool: 'env',
        required: key,
        source: formatSource(root, sourceFile),
        rangeType: 'exact' as const
      };
    }).filter(Boolean);
}

async function readGoMod(root: string): Promise<StackRequirement[]> {
  const content = await cachedReadFile(path.join(root, 'go.mod'));
  const match = content.match(/^go\s+([\d.]+)/m);
  return [{ 
    tool: 'go', 
    required: match ? match[1] : null, 
    source: formatSource(root, 'go.mod'), 
    rangeType: match ? 'min' : 'unknown' 
  }];
}

async function readDockerfile(root: string): Promise<StackRequirement[]> {
  const content = await cachedReadFile(path.join(root, 'Dockerfile'));
  const match = content.match(/^FROM\s+(\S+)/mi);
  if (!match) return [];
  const image = match[1];
  const [imageName, tag] = image.split(':');
  if (!tag) return [];
  const toolMap: Record<string, string> = { node: 'node', python: 'python', golang: 'go', ruby: 'ruby' };
  const tool = toolMap[imageName];
  if (!tool) return [];
  const version = tag.split('-')[0];
  return [{ tool, required: version, source: formatSource(root, 'Dockerfile'), rangeType: 'min' }];
}

async function readExtendedHeuristics(root: string, files: string[]): Promise<StackRequirement[]> {
  const reqs: StackRequirement[] = [];
  
  // Base heuristics
  if (files.includes('requirements.txt') || files.includes('Pipfile')) {
    reqs.push({ tool: 'python', required: null, source: formatSource(root, 'python-heuristic'), rangeType: 'unknown' });
  }
  if (files.includes('Gemfile')) {
    reqs.push({ tool: 'ruby', required: null, source: formatSource(root, 'Gemfile'), rangeType: 'unknown' });
  }
  if (files.includes('docker-compose.yml') || files.includes('docker-compose.yaml')) {
    reqs.push({ tool: 'docker', required: null, source: formatSource(root, 'docker-compose'), rangeType: 'unknown' });
  }

  // Rust
  if (files.includes('Cargo.toml')) {
    reqs.push({ tool: 'rust', required: null, source: formatSource(root, 'Cargo.toml'), rangeType: 'unknown' });
    reqs.push({ tool: 'cargo', required: null, source: formatSource(root, 'Cargo.toml'), rangeType: 'unknown' });
  }

  // PHP
  if (files.includes('composer.json')) {
    reqs.push({ tool: 'php', required: null, source: formatSource(root, 'composer.json'), rangeType: 'unknown' });
    reqs.push({ tool: 'composer', required: null, source: formatSource(root, 'composer.json'), rangeType: 'unknown' });
  }

  // Elixir
  if (files.includes('mix.exs')) {
    reqs.push({ tool: 'elixir', required: null, source: formatSource(root, 'mix.exs'), rangeType: 'unknown' });
    reqs.push({ tool: 'mix', required: null, source: formatSource(root, 'mix.exs'), rangeType: 'unknown' });
  }

  // Flutter / Dart
  if (files.includes('pubspec.yaml')) {
    reqs.push({ tool: 'dart', required: null, source: formatSource(root, 'pubspec.yaml'), rangeType: 'unknown' });
    reqs.push({ tool: 'flutter', required: null, source: formatSource(root, 'pubspec.yaml'), rangeType: 'unknown' });
  }

  // C++ / Make
  if (files.includes('CMakeLists.txt')) {
    reqs.push({ tool: 'cmake', required: null, source: formatSource(root, 'CMakeLists.txt'), rangeType: 'unknown' });
  }
  if (files.includes('Makefile')) {
    reqs.push({ tool: 'make', required: null, source: formatSource(root, 'Makefile'), rangeType: 'unknown' });
  }

  // .NET / C#
  if (files.includes('global.json') || files.some(f => f.endsWith('.csproj') || f.endsWith('.fsproj') || f.endsWith('.sln'))) {
    reqs.push({ tool: 'dotnet', required: null, source: formatSource(root, 'dotnet-heuristic'), rangeType: 'unknown' });
  }

  return reqs;
}

async function readJava(root: string): Promise<StackRequirement[]> {
  const reqs: StackRequirement[] = [];
  reqs.push({ tool: 'java', required: null, source: formatSource(root, 'java-heuristic'), rangeType: 'unknown' });
  try {
    const files = await fs.readdir(root);
    if (files.includes('build.gradle') || files.includes('build.gradle.kts')) {
      reqs.push({ tool: 'gradle', required: null, source: formatSource(root, 'gradle-heuristic'), rangeType: 'unknown' });
    }
    if (files.includes('pom.xml')) {
      reqs.push({ tool: 'maven', required: null, source: formatSource(root, 'maven-heuristic'), rangeType: 'unknown' });
    }
  } catch {}
  return reqs;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function formatSource(root: string, file: string): string {
    const parts = root.split(path.sep);
    const lastDir = parts[parts.length - 1];
    return lastDir && lastDir !== '.' ? `${lastDir}/${file}` : file;
}

const PRIORITY: Record<string, number> = {
  '.tool-versions': 1,
  '.nvmrc': 2,
  '.node-version': 2,
  '.python-version': 2,
  'go.mod': 2,
  'package.json#engines.node': 3,
  'Dockerfile': 4,
};

function deduplicateAndPrioritize(reqs: StackRequirement[], projectPath: string): StackRequirement[] {
  const byTool = new Map<string, StackRequirement[]>();

  for (const req of reqs) {
    if (!byTool.has(req.tool)) byTool.set(req.tool, []);
    byTool.get(req.tool)!.push(req);
  }

  const result: StackRequirement[] = [];
  for (const [tool, toolReqs] of byTool) {
    if (tool === 'env') {
        const seenKeys = new Set();
        for (const req of toolReqs) {
            if (!seenKeys.has(req.required)) {
                result.push(req);
                seenKeys.add(req.required);
            }
        }
        continue;
    }

    if (toolReqs.length === 1) {
      result.push(toolReqs[0]);
      continue;
    }

    toolReqs.sort((a, b) => {
      const pA = Object.entries(PRIORITY).find(([key]) => a.source.includes(key))?.[1] ?? 99;
      const pB = Object.entries(PRIORITY).find(([key]) => b.source.includes(key))?.[1] ?? 99;
      return pA - pB;
    });

    result.push(toolReqs[0]);

    const canonical = toolReqs[0].required;
    for (const other of toolReqs.slice(1)) {
      if (other.required && canonical && !versionsCompatible(canonical, other.required)) {
        result.push({
          tool: `${tool}:conflict`,
          required: `${canonical} (${toolReqs[0].source}) vs ${other.required} (${other.source})`,
          source: 'conflict-detector',
          rangeType: 'unknown'
        });
      }
    }
  }

  return result;
}

function normalizeVersion(v: string): string {
  return v.replace(/^v/, '').trim();
}

const LTS_MAP: Record<string, string> = { 'lts/iron': '20', 'lts/hydrogen': '18', 'lts/gallium': '16', 'lts/*': '20' };

function resolveLtsAlias(v: string): string | null {
  return LTS_MAP[v.toLowerCase()] ?? null;
}

function versionsCompatible(a: string | null, b: string | null): boolean {
  if (!a || !b) return true;
  const majorA = parseInt(a.replace(/[^\d]/, ''));
  const majorB = parseInt(b.replace(/[^\d]/, ''));
  return isNaN(majorA) || isNaN(majorB) || majorA === majorB;
}
