import { CheckResult, Category, Severity } from '@devpulse/shared';
import { StackRequirement } from '../scanner/StackDetector.js';
import { ProbeResult } from '../scanner/SystemProber.js';
import semver from 'semver';

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
  if (checks.length === 0) return 100;
  
  let deductions = 0;
  for (const check of checks) {
    if (!check.passed) {
      const base = SEVERITY_WEIGHTS[check.severity] ?? 0;
      const mult = CATEGORY_MULTIPLIERS[check.category] ?? 1;
      deductions += base * mult;
    }
  }
  return Math.max(0, Math.round(100 - deductions));
}

export function evaluateEnvironment(reqs: StackRequirement[], probes: ProbeResult[]): CheckResult[] {
  const checks: CheckResult[] = [];
  
  const envProbe = probes.find(p => p.tool === 'env:local_keys');
  const localEnvKeys = new Set(envProbe?.found ? envProbe.found.split(',') : []);

  for (const req of reqs) {
    if (req.tool === 'env') {
      checks.push(evaluateEnvRequirement(req, localEnvKeys));
    } else if (req.tool.includes('conflict')) {
      checks.push(evaluateConflictRequirement(req));
    } else {
      checks.push(evaluateToolRequirement(req, probes));
    }
  }

  // Handle unrequested but incorrectly configured features
  checks.push(...evaluateUnrequestedProbes(probes));

  return checks;
}

function evaluateEnvRequirement(req: StackRequirement, localEnvKeys: Set<string>): CheckResult {
  const key = req.required || '';
  const passed = localEnvKeys.has(key) || !!process.env[key];

  return {
    id: `env-${key}`,
    name: 'env',
    category: 'env_var',
    severity: 'critical',
    required: key,
    found: passed ? 'set' : 'missing',
    passed,
    statusLabel: passed ? 'ok' : 'missing'
  };
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
  const isRuntime = ['node', 'python', 'go', 'ruby'].includes(req.tool);
  const isPackageManager = ['pnpm', 'yarn', 'npm'].includes(req.tool);
  
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
    // Only flag if there is a 'reason' indicating a failure for a sub-tool (like docker:daemon)
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
  // Prevent double "v" if version string already specifies it or has a comparator
  if (/^[v<>=~^]/i.test(cleanVersion)) {
    return cleanVersion;
  }
  return `v${cleanVersion}`;
}

function formatFoundVersion(probe: ProbeResult): string {
  if (!probe.found) return 'Not found';
  const v = /^v/i.test(probe.found) ? probe.found : `v${probe.found}`;
  return probe.managedBy ? `${v} [via ${probe.managedBy}]` : v;
}

function satisfiesRequirement(found: string, required: string | null, type: string): boolean {
  if (!required) return true;
  
  // Try to use semver.coerce to extract a valid semantic version string, else gracefully fallback
  const cleanFound = semver.coerce(found)?.version || found.replace(/^[^\d.]+/, '');
  const cleanRequired = required.replace(/^[^\d.]+/, '');
  
  try {
    if (type === 'min') {
      const requiredSemver = semver.coerce(cleanRequired)?.version || cleanRequired;
      return semver.gte(cleanFound, requiredSemver);
    } else if (type === 'exact') {
      const requiredSemver = semver.coerce(cleanRequired)?.version || cleanRequired;
      return semver.eq(cleanFound, requiredSemver);
    } else if (type === 'semver-range') {
      const range = semver.validRange(required) || semver.validRange(cleanRequired) || cleanRequired;
      return semver.satisfies(cleanFound, range);
    }
  } catch {
    // Fallback for completely non-compliant semver items (e.g. just raw startsWith checking)
    return cleanFound.startsWith(cleanRequired.replace(/[^\d.]/g, ''));
  }
  
  return true;
}
