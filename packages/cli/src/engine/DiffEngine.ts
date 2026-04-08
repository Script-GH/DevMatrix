import { CheckResult, Category, Severity } from '@devpulse/shared';
import { StackRequirement } from '../scanner/StackDetector.js';
import { ProbeResult } from '../scanner/SystemProber.js';
import semver from 'semver';

const SEVERITY_WEIGHTS = {
  critical: 25,   
  warning: 10,    
  info: 3,        
};

const CATEGORY_MULTIPLIERS = {
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
      const base = SEVERITY_WEIGHTS[check.severity];
      const mult = CATEGORY_MULTIPLIERS[check.category];
      deductions += base * mult;
    }
  }
  return Math.max(0, Math.round(100 - deductions));
}

export function evaluateEnvironment(reqs: StackRequirement[], probes: ProbeResult[]): CheckResult[] {
    const checks: CheckResult[] = [];
    
    // We need env probe specifically
    const envProbe = probes.find(p => p.tool === 'env:local_keys');
    const localEnvKeys = new Set(envProbe?.found ? envProbe.found.split(',') : []);

    for (const req of reqs) {
        let passed = false;
        let foundStr: string | null = null;
        let category: Category = 'tool';
        let severity: Severity = 'warning';

        let statusLabel: string | undefined;
        let detailsOverride: string | undefined;

        if (req.tool === 'env') {
            category = 'env_var';
            severity = 'critical';
            const key = req.required;
            if (key) {
                passed = localEnvKeys.has(key) || !!process.env[key];
                foundStr = passed ? 'set' : 'missing';
                statusLabel = passed ? 'ok' : 'missing';
            }
        } else if (req.tool.includes('conflict')) {
            category = 'config';
            severity = 'warning';
            passed = false;
            foundStr = 'multiple conflicting versions requested';
            statusLabel = 'mismatch';
        } else {
            const matchingProbes = probes.filter(p => p.tool === req.tool);
            if (matchingProbes.length === 0 || matchingProbes.every(p => !p.found)) {
                passed = false;
                foundStr = 'Not found';
                statusLabel = 'missing';
                severity = req.tool === 'node' || req.tool === 'python' ? 'critical' : 'warning';
                if (['pnpm', 'yarn', 'npm'].includes(req.tool)) category = 'package_manager';
                else if (['node', 'python', 'go', 'ruby'].includes(req.tool)) category = 'runtime';
            } else {
                if (['pnpm', 'yarn', 'npm'].includes(req.tool)) category = 'package_manager';
                else if (['node', 'python', 'go', 'ruby'].includes(req.tool)) category = 'runtime';

                const validProbe = matchingProbes.find(p => p.found && satisfiesRequirement(p.found, req.required, req.rangeType));
                
                if (validProbe) {
                    passed = true;
                    statusLabel = 'ok';
                    foundStr = validProbe.managedBy ? `v${validProbe.found} [via ${validProbe.managedBy}]` : `v${validProbe.found}`;
                } else {
                    passed = false;
                    const primaryProbe = matchingProbes.find(p => p.found);
                    foundStr = primaryProbe ? `v${primaryProbe.found}` : 'Not found';
                    statusLabel = primaryProbe ? 'outdated' : 'missing';
                    severity = category === 'runtime' ? 'critical' : 'warning';
                }
            }
        }

        checks.push({
            id: `${req.tool}-${req.required || 'any'}`,
            name: req.tool,
            category,
            severity,
            required: req.required ? `v${req.required}` : null,
            found: foundStr,
            passed,
            statusLabel
        });
    }

    // Unrequested but installed/problematic features (e.g. docker daemon dead, git email missing, nvm mismatch)
    for (const probe of probes) {
        if (probe.tool.includes(':')) {
            if (probe.tool !== 'env:local_keys') {
                 checks.push({
                     id: probe.tool,
                     name: probe.tool,
                     category: 'config',
                     severity: 'warning',
                     required: 'properly configured',
                     found: probe.reason || 'misconfigured',
                     passed: false,
                     statusLabel: 'mismatch'
                 });
            }
        }
    }

    return checks;
}

function satisfiesRequirement(found: string, required: string | null, type: string): boolean {
    if (!required) return true;
    const cleanFound = found.replace(/^[^\d.]+/, ''); 
    const cleanRequired = required.replace(/^[^\d.]+/, '');
    
    try {
        if (type === 'min') {
            return semver.gte(semver.coerce(cleanFound) || cleanFound, semver.coerce(cleanRequired) || cleanRequired);
        } else if (type === 'exact') {
            return semver.eq(semver.coerce(cleanFound) || cleanFound, semver.coerce(cleanRequired) || cleanRequired);
        } else if (type === 'semver-range') {
            const range = semver.validRange(cleanRequired) || cleanRequired;
            return semver.satisfies(cleanFound, range);
        }
    } catch {
        return cleanFound.startsWith(cleanRequired.replace(/[^\d.]/g, ''));
    }
    return true;
}
