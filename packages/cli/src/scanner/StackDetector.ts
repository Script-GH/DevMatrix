import fs from 'fs/promises';
import path from 'path';
import { parse as parseToml } from '@iarna/toml';

export interface StackRequirement {
  tool: string;
  required: string | null;
  source: string;          // which file this came from
  rangeType: 'exact' | 'semver-range' | 'min' | 'unknown';
}

export async function detectStack(projectPath: string): Promise<StackRequirement[]> {
  const requirements: StackRequirement[] = [];
  const readers = [
    readToolVersions,
    readNvmrc,
    readPackageJson,
    readPyprojectToml,
    readGoMod,
    readDockerfile,
    readEnvExample,
  ];

  // Run all readers in parallel — they're all just file reads
  const results = await Promise.allSettled(
    readers.map(r => r(projectPath))
  );

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.length > 0) {
      requirements.push(...result.value);
    }
    // silently skip files that don't exist (rejected = file not found)
  }

  return deduplicateAndPrioritize(requirements);
}

// ─── Individual readers ───────────────────────────────────────────────

async function readNvmrc(root: string): Promise<StackRequirement[]> {
  const content = await fs.readFile(path.join(root, '.nvmrc'), 'utf8');
  const raw = content.trim();
  // Resolve LTS aliases: "lts/iron" → "20", "lts/*" → "latest LTS"
  const version = resolveLtsAlias(raw) ?? normalizeVersion(raw);
  return [{ tool: 'node', required: version, source: '.nvmrc', rangeType: 'exact' }];
}

async function readPackageJson(root: string): Promise<StackRequirement[]> {
  const content = await fs.readFile(path.join(root, 'package.json'), 'utf8');
  const pkg = JSON.parse(content);
  const reqs: StackRequirement[] = [];

  if (pkg.engines?.node) {
    reqs.push({
      tool: 'node',
      required: pkg.engines.node,
      source: 'package.json#engines.node',
      rangeType: 'semver-range'
    });
  }
  if (pkg.engines?.npm) {
    reqs.push({
      tool: 'npm',
      required: pkg.engines.npm,
      source: 'package.json#engines.npm',
      rangeType: 'semver-range'
    });
  }
  if (pkg.packageManager) {
    // "pnpm@8.15.0" → { tool: "pnpm", required: "8.15.0" }
    const [manager, version] = pkg.packageManager.split('@');
    reqs.push({
      tool: manager,
      required: version ?? null,
      source: 'package.json#packageManager',
      rangeType: version ? 'exact' : 'unknown'
    });
  }
  return reqs;
}

async function readToolVersions(root: string): Promise<StackRequirement[]> {
  const content = await fs.readFile(path.join(root, '.tool-versions'), 'utf8');
  return content
    .split('\n')
    .filter(line => line.trim() && !line.startsWith('#'))
    .map(line => {
      const [tool, version] = line.trim().split(/\s+/);
      // asdf uses "nodejs" not "node" — normalize
      const normalizedTool = tool === 'nodejs' ? 'node' : tool;
      return {
        tool: normalizedTool,
        required: version ?? null,
        source: '.tool-versions',
        rangeType: 'exact' as const
      };
    });
}

async function readPyprojectToml(root: string): Promise<StackRequirement[]> {
  const content = await fs.readFile(path.join(root, 'pyproject.toml'), 'utf8');
  const parsed = parseToml(content) as any;
  const reqs: StackRequirement[] = [];

  // PEP 621 format
  const requiresPython = parsed?.project?.['requires-python'];
  if (requiresPython) {
    reqs.push({
      tool: 'python',
      required: requiresPython,
      source: 'pyproject.toml#project.requires-python',
      rangeType: 'semver-range'
    });
  }

  // Poetry format
  const poetryPython = parsed?.tool?.poetry?.dependencies?.python;
  if (poetryPython) {
    reqs.push({
      tool: 'python',
      required: poetryPython,
      source: 'pyproject.toml#tool.poetry.dependencies.python',
      rangeType: 'semver-range'
    });
  }

  return reqs;
}

async function readEnvExample(root: string): Promise<StackRequirement[]> {
  // Try both common filenames
  let content: string;
  try {
    content = await fs.readFile(path.join(root, '.env.example'), 'utf8');
  } catch {
    content = await fs.readFile(path.join(root, '.env.template'), 'utf8');
  }

  return content
    .split('\n')
    .filter(line => line.trim() && !line.startsWith('#'))
    .map(line => {
      const key = line.split('=')[0].trim();
      return {
        tool: 'env',
        required: key,   // the KEY name is the "requirement"
        source: '.env.example',
        rangeType: 'exact' as const
      };
    });
}

async function readGoMod(root: string): Promise<StackRequirement[]> {
  const content = await fs.readFile(path.join(root, 'go.mod'), 'utf8');
  const match = content.match(/^go\s+([\d.]+)/m);
  if (!match) return [];
  return [{ tool: 'go', required: match[1], source: 'go.mod', rangeType: 'min' }];
}

async function readDockerfile(root: string): Promise<StackRequirement[]> {
  const content = await fs.readFile(path.join(root, 'Dockerfile'), 'utf8');
  const match = content.match(/^FROM\s+(\S+)/mi);
  if (!match) return [];
  // "node:20-alpine" → tool: node, version: 20
  const image = match[1];
  const [imageName, tag] = image.split(':');
  if (!tag) return [];
  const toolMap: Record<string, string> = {
    node: 'node', python: 'python', golang: 'go', ruby: 'ruby'
  };
  const tool = toolMap[imageName];
  if (!tool) return [];
  const version = tag.split('-')[0]; // strip "-alpine", "-slim" etc.
  return [{ tool, required: version, source: 'Dockerfile', rangeType: 'min' }];
}

// ─── Deduplication ────────────────────────────────────────────────────

const PRIORITY: Record<string, number> = {
  '.tool-versions': 1,
  '.nvmrc': 2,
  '.node-version': 2,
  '.python-version': 2,
  'go.mod': 2,
  'package.json#engines.node': 3,
  'pyproject.toml#project.requires-python': 3,
  'pyproject.toml#tool.poetry.dependencies.python': 3,
  'Dockerfile': 4,
};

function deduplicateAndPrioritize(reqs: StackRequirement[]): StackRequirement[] {
  const byTool = new Map<string, StackRequirement[]>();

  for (const req of reqs) {
    if (!byTool.has(req.tool)) byTool.set(req.tool, []);
    byTool.get(req.tool)!.push(req);
  }

  const result: StackRequirement[] = [];
  for (const [, toolReqs] of byTool) {
    if (toolReqs.length === 1) {
      result.push(toolReqs[0]);
      continue;
    }
    // Sort by priority, keep highest priority as the canonical requirement
    // Flag conflicts if versions disagree significantly
    toolReqs.sort((a, b) =>
      (PRIORITY[a.source] ?? 99) - (PRIORITY[b.source] ?? 99)
    );
    result.push(toolReqs[0]);

    // Detect conflicts — e.g. .nvmrc says 18, package.json says >=20
    const canonical = toolReqs[0].required;
    for (const other of toolReqs.slice(1)) {
      if (other.required && !versionsCompatible(canonical, other.required)) {
        // Emit a conflict requirement — the AI layer will explain it
        result.push({
          tool: `${toolReqs[0].tool}:conflict`,
          required: `${canonical} (${toolReqs[0].source}) vs ${other.required} (${other.source})`,
          source: 'conflict-detector',
          rangeType: 'unknown'
        });
      }
    }
  }

  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function normalizeVersion(v: string): string {
  return v.replace(/^v/, '').trim();
}

const LTS_MAP: Record<string, string> = {
  'lts/iron': '20',
  'lts/hydrogen': '18',
  'lts/gallium': '16',
  'lts/*': '20',  // assume current LTS
};

function resolveLtsAlias(v: string): string | null {
  return LTS_MAP[v.toLowerCase()] ?? null;
}

function versionsCompatible(a: string | null, b: string | null): boolean {
  if (!a || !b) return true;
  // Simple major-version check for conflict detection
  const majorA = parseInt(a.replace(/[^\d]/, ''));
  const majorB = parseInt(b.replace(/[^\d]/, ''));
  return majorA === majorB;
}
