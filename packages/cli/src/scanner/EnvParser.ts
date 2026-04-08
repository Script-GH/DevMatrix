import fs from 'fs/promises';
import path from 'path';
import { parse as parseYaml } from 'yaml';

export type EnvKeyType = 
  | 'string' 
  | 'url' 
  | 'integer' 
  | 'boolean' 
  | `enum(${string})`;

export type EnvKeyStatus =
  | 'present-valid'
  | 'present-invalid'   // set but fails type check
  | 'missing-required'
  | 'missing-optional'
  | 'default-used';     // not set but .env.defaults provides a fallback

export interface EnvKeyResult {
  key: string;
  status: EnvKeyStatus;
  type: EnvKeyType;
  required: boolean;
  source: string | null;    // where the value was found (.env, process.env, etc.)
  validationError?: string; // what's wrong with the value, if invalid
  description?: string;     // from .env.schema comments
}

export interface EnvParseResult {
  keys: EnvKeyResult[];
  schemaSource: string;     // which file defined the requirements
  localEnvFound: boolean;   // did we find a .env file at all?
  missingEnvFile: boolean;  // .env.example exists but .env does not
}

// ─── Main entry point ──────────────────────────────────────────────

export async function parseEnv(projectPath: string): Promise<EnvParseResult> {
  const schema = await loadEnvSchema(projectPath);
  const actualEnv = await loadActualEnv(projectPath);

  const keys = schema.keys.map(requirement =>
    evaluateKey(requirement, actualEnv)
  );

  const dockerKeys = await parseDockerCompose(projectPath);
  for (const dk of dockerKeys) {
    if (!keys.find(k => k.key === dk.key)) {
      keys.push(evaluateKey(dk, actualEnv));
    }
  }

  return {
    keys,
    schemaSource: schema.source,
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

async function loadEnvSchema(projectPath: string): Promise<LoadedSchema> {
  const candidates = [
    { file: '.env.schema',   parser: parseSchemaFile },
    { file: '.env.example',  parser: parseExampleFile },
    { file: '.env.template', parser: parseExampleFile },
    { file: '.env.sample',   parser: parseExampleFile },
    { file: '.env.defaults', parser: parseExampleFile },
  ];

  for (const { file, parser } of candidates) {
    try {
      const content = await fs.readFile(path.join(projectPath, file), 'utf8');
      const keys = parser(content);
      if (keys.length > 0) return { keys, source: file };
    } catch {
      // file doesn't exist, try next
    }
  }

  return { keys: [], source: 'none' };
}

function parseSchemaFile(content: string): EnvRequirement[] {
  const requirements: EnvRequirement[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('##')) continue;

    const [definition, ...commentParts] = trimmed.split('#');
    const description = commentParts.join('#').trim() || undefined;
    const defTrimmed = definition.trim();
    if (!defTrimmed) continue;

    const [key, typeSpec] = defTrimmed.split('=');
    if (!key) continue;

    if (!typeSpec) {
      requirements.push({ key: key.trim(), type: 'string', required: true, description });
      continue;
    }

    const parts = typeSpec.split(':');
    
    // Normalize type string against our EnvKeyType union
    let rawType = (parts[0] ?? 'string').trim() as string;
    let type: EnvKeyType = 'string';
    
    if (['string', 'url', 'integer', 'boolean'].includes(rawType)) {
      type = rawType as EnvKeyType;
    } else if (rawType.startsWith('enum(') && rawType.endsWith(')')) {
      type = rawType as EnvKeyType;
    }

    const required = (parts[1] ?? 'required').trim() !== 'optional';
    const defaultValue = parts[2]?.trim();

    requirements.push({
      key: key.trim(),
      type,
      required,
      description,
      defaultValue,
    });
  }

  return requirements;
}

function parseExampleFile(content: string): EnvRequirement[] {
  const requirements: EnvRequirement[] = [];
  let pendingDescription: string | undefined;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    if (trimmed.startsWith('#')) {
      const comment = trimmed.slice(1).trim();
      pendingDescription = comment.length < 80 ? comment : undefined;
      continue;
    }

    if (!trimmed) {
      pendingDescription = undefined;
      continue;
    }

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    const placeholderValue = trimmed.slice(eqIndex + 1).trim();

    const type = inferTypeFromPlaceholder(key, placeholderValue, pendingDescription);

    const commentLower = (pendingDescription ?? '').toLowerCase();
    const required = !commentLower.includes('optional') &&
                     !commentLower.includes('if you') &&
                     !commentLower.includes('only if') &&
                     !key.startsWith('OPTIONAL_');

    requirements.push({
      key,
      type,
      required,
      description: pendingDescription,
      defaultValue: isPlaceholder(placeholderValue) ? undefined : placeholderValue,
    });

    pendingDescription = undefined;
  }

  return requirements;
}

function inferTypeFromPlaceholder(key: string, value: string, pendingDescription?: string): EnvKeyType {
  const keyLower = key.toLowerCase();

  // Try to infer from explicit mentions in the comment first
  if (pendingDescription) {
    const descLower = pendingDescription.toLowerCase();
    if (descLower.includes('(boolean)') || descLower.includes('true/false')) return 'boolean';
    if (descLower.includes('(integer)') || descLower.includes('(number)')) return 'integer';
    if (descLower.includes('(url)')) return 'url';
  }

  if (value.startsWith('http://') || value.startsWith('https://') ||
      keyLower.includes('url') || keyLower.includes('endpoint') ||
      keyLower.includes('host') && keyLower.includes('api')) {
    return 'url';
  }
  if (keyLower === 'port' || keyLower.includes('_port') ||
      keyLower.includes('timeout') || keyLower.includes('_ttl') ||
      keyLower.includes('max_') || keyLower.includes('_count')) {
    return 'integer';
  }
  if (keyLower.includes('enabled') || keyLower.includes('debug') ||
      keyLower.includes('verbose') || value === 'true' || value === 'false') {
    return 'boolean';
  }
  if (keyLower === 'node_env' || keyLower === 'app_env' || keyLower === 'environment') {
    return 'enum(development,test,production,staging)';
  }
  return 'string';
}

function isPlaceholder(value: string): boolean {
  const placeholderPatterns = [
    /^your[_-]/i, /^<.*>$/, /^{.*}$/, /^xxx/i,
    /^changeme/i, /^replace/i, /^todo/i, /^example/i,
    /^(sk|pk|rk)-test-/i, 
  ];
  return placeholderPatterns.some(p => p.test(value.trim()));
}

// ─── Actual env loading ────────────────────────────────────────────

interface ActualEnv {
  values: Map<string, string>;
  hasLocalFile: boolean;
  sources: Map<string, string>;
}

async function loadActualEnv(projectPath: string): Promise<ActualEnv> {
  const values = new Map<string, string>();
  const sources = new Map<string, string>();
  let hasLocalFile = false;

  const envFiles = [
    '.env.defaults',
    '.env',
    '.env.local',
    '.env.development',
    `.env.${process.env.NODE_ENV ?? 'development'}`,
  ];

  for (const envFile of envFiles) {
    try {
      const content = await fs.readFile(path.join(projectPath, envFile), 'utf8');
      if (envFile === '.env') hasLocalFile = true;
      
      parseActualEnvContentSafely(content, values, sources, envFile);
    } catch {
      // file doesn't exist, skip
    }
  }

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !values.has(key)) {
      values.set(key, value);
      sources.set(key, 'process.env');
    }
  }

  return { values, hasLocalFile, sources };
}

// Robust, zero-dependency parser handling multi-line strings and inline comments
function parseActualEnvContentSafely(
  content: string, 
  valuesMap: Map<string, string>, 
  sourcesMap: Map<string, string>, 
  sourceName: string
) {
  const lines = content.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    // Check for inline comments outside of quotes
    const commentIndex = value.indexOf(' #'); 
    if (commentIndex !== -1 && !value.startsWith('"') && !value.startsWith("'")) {
        value = value.slice(0, commentIndex).trim();
    }

    // Handle string quotes and basic multi-line
    const quoteCharMatch = value.match(/^(['"])/);
    if (quoteCharMatch) {
      const quoteChar = quoteCharMatch[1];
      
      if (!value.endsWith(quoteChar) || value.length === 1) {
        // Looks like a multi-line value
        let multiLineValue = value.slice(1) + '\n';
        while (++i < lines.length) {
          multiLineValue += lines[i] + '\n';
          if (lines[i].trim().endsWith(quoteChar)) {
            multiLineValue = multiLineValue.trim().slice(0, -1);
            break;
          }
        }
        value = multiLineValue;
      } else {
        // Enclosed in quotes on same line
        value = value.slice(1, -1);
      }
    }

    valuesMap.set(key, value);
    sourcesMap.set(key, sourceName);
  }
}

// ─── Key evaluation ────────────────────────────────────────────────

function evaluateKey(req: EnvRequirement, actual: ActualEnv): EnvKeyResult {
  const value = actual.values.get(req.key);
  const source = actual.sources.get(req.key) ?? null;

  if (value === undefined || value === '') {
    if (req.defaultValue) {
      return {
        key: req.key,
        status: 'default-used',
        type: req.type,
        required: req.required,
        source: null,
        description: req.description,
      };
    }
    return {
      key: req.key,
      status: req.required ? 'missing-required' : 'missing-optional',
      type: req.type,
      required: req.required,
      source: null,
      description: req.description,
    };
  }

  const validationError = validateValue(req.key, value, req.type);

  return {
    key: req.key,
    status: validationError ? 'present-invalid' : 'present-valid',
    type: req.type,
    required: req.required,
    source,
    validationError,
    description: req.description,
  };
}

// ─── Type validators ───────────────────────────────────────────────

function validateValue(key: string, value: string, type: EnvKeyType): string | undefined {
  switch (type) {
    case 'url':
      return validateUrl(value);
    case 'integer':
      return validateInteger(value);
    case 'boolean':
      return validateBoolean(value);
    default:
      if (type.startsWith('enum(')) {
        return validateEnum(value, type);
      }
      return validateString(key, value);
  }
}

function validateUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    // Removed strict protocol check in favor of structural validation
    // to support things like sqlite://, redis://, amqp://, etc without false positives
    if (!url.protocol || !url.host && url.protocol !== 'sqlite:' && url.protocol !== 'file:') {
      return `URL looks incomplete — missing host or protocol ("${truncate(value)}")`;
    }
    return undefined;
  } catch {
    return `"${truncate(value)}" is not a valid URL format.`;
  }
}

function validateInteger(value: string): string | undefined {
  if (value.trim() === '') return `Expected an integer, got empty value`;
  const n = Number(value);
  if (!Number.isInteger(n)) {
    return `Expected an integer, got "${truncate(value)}"`;
  }
  return undefined;
}

function validateBoolean(value: string): string | undefined {
  const valid = ['true', 'false', '1', '0', 'yes', 'no'];
  if (!valid.includes(value.toLowerCase())) {
    return `Expected true/false, got "${truncate(value)}"`;
  }
  return undefined;
}

function validateEnum(value: string, type: string): string | undefined {
  const allowed = type.slice(5, -1).split(',').map(s => s.trim());
  if (!allowed.includes(value)) {
    return `Expected one of [${allowed.join(', ')}], got "${truncate(value)}"`;
  }
  return undefined;
}

function validateString(key: string, value: string): string | undefined {
  if (isPlaceholder(value)) {
    return `Value looks like an unreplaced placeholder: "${truncate(value)}"`;
  }
  if (key.toLowerCase().includes('api_key') ||
      key.toLowerCase().includes('secret') ||
      key.toLowerCase().includes('token')) {
    if (value.length < 20) {
      return `API key/secret seems too short (${value.length} chars) — may be a placeholder`;
    }
  }
  return undefined;
}

function truncate(s: string, max = 20): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

// ─── Docker Compose parsing ────────────────────────────────────────

async function parseDockerCompose(projectPath: string): Promise<EnvRequirement[]> {
  const candidates = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml'];
  const requirements: EnvRequirement[] = [];

  for (const file of candidates) {
    try {
      const content = await fs.readFile(path.join(projectPath, file), 'utf8');
      const parsed = parseYaml(content) as any;
      const services = parsed?.services ?? {};

      for (const [, service] of Object.entries(services) as any) {
        const envSection = service?.environment;
        
        // Handle List mode (array format)
        if (Array.isArray(envSection)) {
          for (const entry of envSection) {
            if (typeof entry === 'string' && !entry.includes('=')) {
              requirements.push({
                key: entry.trim(),
                type: 'string',
                required: true,
                description: `Required by ${file} service`,
              });
            }
          }
        } 
        // Handle Dictionary mode (object format)
        else if (typeof envSection === 'object' && envSection !== null) {
          for (const [key, val] of Object.entries(envSection)) {
            // Null or empty value in a dictionary means it's required from host env
            if (val === null || val === '') {
              requirements.push({
                key: key.trim(),
                type: 'string',
                required: true,
                description: `Required by ${file} service`,
              });
            }
          }
        }
      }
      break; // found one, stop looking
    } catch {
      // file doesn't exist or invalid YAML
    }
  }

  return requirements;
}
