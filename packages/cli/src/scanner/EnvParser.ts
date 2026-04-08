import fs from 'fs/promises';
import path from 'path';
import { parse as parseYaml } from 'yaml';

export type EnvKeyType = 'string' | 'url' | 'integer' | 'boolean' | `enum(${string})`;
export type EnvKeyStatus = 'present-valid' | 'present-invalid' | 'missing-required' | 'missing-optional' | 'default-used';

export interface EnvKeyResult {
  key: string;
  status: EnvKeyStatus;
  type: EnvKeyType;
  required: boolean;
  source: string | null;
  validationError?: string;
  description?: string;
}

export interface EnvParseResult {
  keys: EnvKeyResult[];
  schemaSource: string;
  localEnvFound: boolean;
  missingEnvFile: boolean;
}

// ─── Main entry point ──────────────────────────────────────────────

export async function parseEnv(projectPath: string, subdirs: string[] = []): Promise<EnvParseResult[]> {
  const pathsToScan = [projectPath, ...subdirs];
  const results = await Promise.all(pathsToScan.map(p => scanDirForEnv(p, projectPath)));
  return results.filter(r => r.keys.length > 0);
}

async function scanDirForEnv(dir: string, root: string): Promise<EnvParseResult> {
  const schema = await loadEnvSchema(dir);
  const actualEnv = await loadActualEnv(dir);
  
  const keys = schema.keys.map(requirement => evaluateKey(requirement, actualEnv));
  
  // Docker Compose integration
  const dockerKeys = await parseDockerCompose(dir);
  for (const dk of dockerKeys) {
    if (!keys.find(k => k.key === dk.key)) {
      keys.push(evaluateKey(dk, actualEnv));
    }
  }

  const relPath = path.relative(root, dir) || '.';

  return {
    keys,
    schemaSource: schema.source !== 'none' ? `${relPath}/${schema.source}` : 'none',
    localEnvFound: actualEnv.hasLocalFile,
    missingEnvFile: schema.keys.length > 0 && !actualEnv.hasLocalFile,
  };
}

// ─── Schema loading ────────────────────────────────────────────────

interface EnvRequirement {
  key: string;
  type: EnvKeyType;
  required: boolean;
  description?: string;
  defaultValue?: string;
}

interface LoadedSchema {
  keys: EnvRequirement[];
  source: string;
}

async function loadEnvSchema(dir: string): Promise<LoadedSchema> {
  const candidates = ['.env.schema', '.env.example', '.env.template', '.env.sample', '.env.defaults'];
  for (const file of candidates) {
    try {
      const content = await fs.readFile(path.join(dir, file), 'utf8');
      const keys = file === '.env.schema' ? parseSchemaFile(content) : parseExampleFile(content);
      if (keys.length > 0) return { keys, source: file };
    } catch {}
  }
  return { keys: [], source: 'none' };
}

function parseSchemaFile(content: string): EnvRequirement[] {
  const requirements: EnvRequirement[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [definition, ...commentParts] = trimmed.split('#');
    const description = commentParts.join('#').trim() || undefined;
    const [key, typeSpec] = definition.trim().split('=');
    if (!key) continue;
    
    let type: EnvKeyType = 'string';
    let required = true;
    let defaultValue: string | undefined;

    if (typeSpec) {
        const parts = typeSpec.split(':');
        type = (parts[0]?.trim() || 'string') as EnvKeyType;
        required = (parts[1]?.trim() || 'required') !== 'optional';
        defaultValue = parts[2]?.trim();
    }
    
    requirements.push({ key: key.trim(), type, required, description, defaultValue });
  }
  return requirements;
}

function parseExampleFile(content: string): EnvRequirement[] {
  const requirements: EnvRequirement[] = [];
  let pendingDescription: string | undefined;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      pendingDescription = trimmed.slice(1).trim();
      continue;
    }
    if (!trimmed) { pendingDescription = undefined; continue; }

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    const type = inferType(key, value, pendingDescription);
    const required = !key.startsWith('OPTIONAL_') && !(pendingDescription?.toLowerCase().includes('optional'));

    requirements.push({
      key,
      type,
      required,
      description: pendingDescription,
      defaultValue: value || undefined
    });
    pendingDescription = undefined;
  }
  return requirements;
}

function inferType(key: string, value: string, desc?: string): EnvKeyType {
    const k = key.toLowerCase();
    const d = desc?.toLowerCase() || '';
    if (k.includes('url') || k.includes('endpoint') || value.startsWith('http')) return 'url';
    if (k.includes('port') || k.includes('count') || k.includes('ttl')) return 'integer';
    if (k.includes('enabled') || k.includes('debug') || value === 'true' || value === 'false') return 'boolean';
    return 'string';
}

// ─── Actual env loading ────────────────────────────────────────────

interface ActualEnv {
  values: Map<string, string>;
  hasLocalFile: boolean;
  sources: Map<string, string>;
}

async function loadActualEnv(dir: string): Promise<ActualEnv> {
    const values = new Map<string, string>();
    const sources = new Map<string, string>();
    let hasLocalFile = false;
    const files = ['.env.defaults', '.env', '.env.local', '.env.development'];

    for (const f of files) {
        try {
            const content = await fs.readFile(path.join(dir, f), 'utf8');
            if (f === '.env') hasLocalFile = true;
            parseEnvContent(content, values, sources, f);
        } catch {}
    }
    return { values, hasLocalFile, sources };
}

function parseEnvContent(content: string, vMap: Map<string, string>, sMap: Map<string, string>, source: string) {
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx+1).trim().replace(/^['"](.*)['"]$/, '$1');
        vMap.set(key, val);
        sMap.set(key, source);
    }
}

// ─── Evaluation & Docker ───────────────────────────────────────────

function evaluateKey(req: EnvRequirement, actual: ActualEnv): EnvKeyResult {
    const value = actual.values.get(req.key) || process.env[req.key];
    const source = actual.sources.get(req.key) || (process.env[req.key] ? 'process.env' : null);

    if (!value) {
        return {
            key: req.key,
            status: req.required ? 'missing-required' : 'missing-optional',
            type: req.type,
            required: req.required,
            source: null,
            description: req.description
        };
    }

    return {
        key: req.key,
        status: 'present-valid', // Validation could be added here
        type: req.type,
        required: req.required,
        source,
        description: req.description
    };
}

async function parseDockerCompose(dir: string): Promise<EnvRequirement[]> {
    const files = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml'];
    for (const f of files) {
        try {
            const content = await fs.readFile(path.join(dir, f), 'utf8');
            const parsed = parseYaml(content) as any;
            const reqs: EnvRequirement[] = [];
            for (const service of Object.values(parsed?.services || {}) as any) {
                const env = service.environment || {};
                const entries = Array.isArray(env) ? env.map(e => e.split('=')) : Object.entries(env);
                for (const [k, v] of entries) {
                    if (!v) reqs.push({ key: k, type: 'string', required: true, description: `Docker ${f}` });
                }
            }
            return reqs;
        } catch {}
    }
    return [];
}
