import { CheckResult, Category, Severity } from '@devpulse/shared';
import { StackRequirement } from '../scanner/StackDetector.js';
import { ProbeResult } from '../scanner/SystemProber.js';
import { EnvKeyResult } from '../scanner/EnvParser.js';
import semver from 'semver';
import type { DependencyMap } from '../scanner/StackDetector.js';

const SEVERITY_WEIGHTS: Record<Severity, number> = {
  critical: 25,
  warning: 10,
  info: 3,
};

const CATEGORY_MULTIPLIERS: Record<Category, number> = {
  runtime: 1.5,
  package_manager: 1.2,
  env_var: 1.3,
  tool: 0.8,
  config: 0.6,
};

export function computeScore(checks: CheckResult[]): number {
  if (checks.length === 0) return -1;

  let totalWeight = 0;
  let failedWeight = 0;
  for (const check of checks) {
    const base = SEVERITY_WEIGHTS[check.severity] ?? 0;
    const mult = CATEGORY_MULTIPLIERS[check.category] ?? 1;
    const weight = base * mult;
    totalWeight += weight;
    if (!check.passed) failedWeight += weight;
  }

  if (totalWeight <= 0) return 100;
  const score = 100 - (failedWeight / totalWeight) * 100;
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ─── Dependency Diff ─────────────────────────────────────────────────────────

export interface DependencyChange {
  name: string;
  oldVersion: string;
  newVersion: string;
}

export interface DependencyDiff {
  added: string[];           // names only (new keys)
  updated: DependencyChange[];
  removed: string[];         // names only
}

/**
 * Computes the diff between two dependency maps.
 * Returns added, updated (with version change), and removed entries.
 */
export function getDependencyDiff(
  oldDeps: DependencyMap,
  newDeps: DependencyMap
): DependencyDiff {
  const added: string[] = [];
  const updated: DependencyChange[] = [];
  const removed: string[] = [];

  for (const [name, newVer] of Object.entries(newDeps)) {
    if (!(name in oldDeps)) {
      added.push(name);
    } else if (oldDeps[name] !== newVer) {
      updated.push({ name, oldVersion: oldDeps[name], newVersion: newVer });
    }
  }

  for (const name of Object.keys(oldDeps)) {
    if (!(name in newDeps)) {
      removed.push(name);
    }
  }

  return { added, updated, removed };
}

export function evaluateEnvironment(
    reqs: StackRequirement[], 
    probes: ProbeResult[], 
    envResults: EnvKeyResult[] = []
): CheckResult[] {
  const checks: CheckResult[] = [];
  
  // 1. Evaluate tool requirements
  for (const req of reqs) {
    if (req.tool === 'env') continue; // Handled by envResults
    if (req.tool.includes('conflict')) {
      checks.push(evaluateConflictRequirement(req));
    } else {
      checks.push(evaluateToolRequirement(req, probes));
    }
  }

  // 2. Convert optimized EnvParser results to CheckResults
  for (const env of envResults) {
      const passed = env.status === 'present-valid' || env.status === 'default-used';
      checks.push({
          id: `env-${env.key}`,
          name: 'env',
          category: 'env_var',
          severity: env.required ? 'critical' : 'warning',
          required: env.key,
          found: env.status === 'missing-required' || env.status === 'missing-optional' ? 'missing' : 'set',
          passed,
          statusLabel: env.status === 'present-valid' ? 'ok' : env.status.replace('present-', '').replace('missing-', '')
      });
  }

  // 3. Handle unrequested but incorrectly configured features
  checks.push(...evaluateUnrequestedProbes(probes));

  return checks;
}

function evaluateConflictRequirement(req: StackRequirement): CheckResult {
  return {
    id: `conflict-${req.tool}`,
    name: req.tool,
    category: 'config',
    severity: 'warning',
    required: req.required,
    found: 'multiple conflicting versions requested',
    passed: false,
    statusLabel: 'mismatch'
  };
}

function evaluateToolRequirement(req: StackRequirement, probes: ProbeResult[]): CheckResult {
  const matchingProbes = probes.filter(p => p.tool === req.tool);
  const isRuntime = ['node', 'python', 'go', 'ruby', 'java', 'rust', 'php', 'dotnet', 'elixir', 'dart'].includes(req.tool);
  const isPackageManager = ['pnpm', 'yarn', 'npm', 'gradle', 'maven', 'cargo', 'composer', 'mix', 'cmake', 'make', 'flutter'].includes(req.tool);
  
  const category: Category = isRuntime ? 'runtime' : isPackageManager ? 'package_manager' : 'tool';
  const defaultSeverity: Severity = isRuntime ? 'critical' : 'warning';
  const formattedRequired = formatRequiredVersion(req.required);

  if (matchingProbes.length === 0 || matchingProbes.every(p => !p.found)) {
    return {
      id: `${req.tool}-${req.required || 'any'}`,
      name: req.tool,
      category,
      severity: defaultSeverity,
      required: formattedRequired,
      found: 'Not found',
      passed: false,
      statusLabel: 'missing'
    };
  }

  const validProbe = matchingProbes.find(p => p.found && satisfiesRequirement(p.found, req.required, req.rangeType));
  
  if (validProbe) {
    return {
      id: `${req.tool}-${req.required || 'any'}`,
      name: req.tool,
      category,
      severity: defaultSeverity,
      required: formattedRequired,
      found: formatFoundVersion(validProbe),
      passed: true,
      statusLabel: 'ok'
    };
  } else {
    const primaryProbe = matchingProbes.find(p => p.found);
    return {
      id: `${req.tool}-${req.required || 'any'}`,
      name: req.tool,
      category,
      severity: defaultSeverity,
      required: formattedRequired,
      found: primaryProbe ? formatFoundVersion(primaryProbe) : 'Not found',
      passed: false,
      statusLabel: primaryProbe ? 'outdated' : 'missing'
    };
  }
}

function evaluateUnrequestedProbes(probes: ProbeResult[]): CheckResult[] {
  const checks: CheckResult[] = [];
  for (const probe of probes) {
    if (probe.tool.includes(':') && probe.tool !== 'env:local_keys' && probe.reason) {
      checks.push({
        id: `config-${probe.tool.replace(':', '-')}`,
        name: probe.tool,
        category: 'config',
        severity: 'warning',
        required: 'properly configured',
        found: probe.reason,
        passed: false,
        statusLabel: 'mismatch'
      });
    }
  }
  return checks;
}

function formatRequiredVersion(version: string | null): string | null {
  if (!version) return null;
  const cleanVersion = version.trim();
  if (/^[v<>=~^]/i.test(cleanVersion)) return cleanVersion;
  return `v${cleanVersion}`;
}

function formatFoundVersion(probe: ProbeResult): string {
  if (!probe.found) return 'Not found';
  const v = /^v/i.test(probe.found) ? probe.found : `v${probe.found}`;
  return probe.managedBy ? `${v} [via ${probe.managedBy}]` : v;
}

function satisfiesRequirement(found: string, required: string | null, type: string): boolean {
  if (!required) return true;
  const cleanFound = semver.coerce(found)?.version || found.replace(/^[^\d.]+/, '');
  const cleanRequired = required.replace(/^[^\d.]+/, '');
  try {
    if (type === 'min') return semver.gte(cleanFound, semver.coerce(cleanRequired)?.version || cleanRequired);
    if (type === 'exact') return semver.eq(cleanFound, semver.coerce(cleanRequired)?.version || cleanRequired);
    if (type === 'semver-range') {
      const range = semver.validRange(required) || semver.validRange(cleanRequired) || cleanRequired;
      return semver.satisfies(cleanFound, range);
    }
  } catch {
    return cleanFound.startsWith(cleanRequired.replace(/[^\d.]/g, ''));
  }
  return true;
}
