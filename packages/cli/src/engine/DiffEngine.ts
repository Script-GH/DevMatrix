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

        if (req.tool === 'env') {
            category = 'env_var';
            severity = 'critical'; // missing env var is usually critical
            // req.required is the key name
            const key = req.required;
            if (key) {
                passed = localEnvKeys.has(key) || !!process.env[key];
                foundStr = passed ? 'set' : 'missing';
            }
        } else if (req.tool.includes('conflict')) {
            category = 'config';
            severity = 'warning';
            passed = false; // conflicts always fail
            foundStr = 'multiple conflicting versions requested';
        } else {
            // standard tool evaluation
            const matchingProbes = probes.filter(p => p.tool === req.tool);
            // It could be missing entirely
            if (matchingProbes.length === 0 || matchingProbes.every(p => !p.found)) {
                passed = false;
                foundStr = null;
                severity = req.tool === 'node' || req.tool === 'python' ? 'critical' : 'warning';
                if (['pnpm', 'yarn', 'npm'].includes(req.tool)) category = 'package_manager';
                else if (['node', 'python', 'go', 'ruby'].includes(req.tool)) category = 'runtime';
            } else {
                // Determine category
                if (['pnpm', 'yarn', 'npm'].includes(req.tool)) category = 'package_manager';
                else if (['node', 'python', 'go', 'ruby'].includes(req.tool)) category = 'runtime';

                // Find a probe that satisfies the requirement
                const validProbe = matchingProbes.find(p => p.found && satisfiesRequirement(p.found, req.required, req.rangeType));
                
                if (validProbe) {
                    passed = true;
                    // Note if it was managed by a specific tool
                    foundStr = validProbe.managedBy ? `${validProbe.found} [via ${validProbe.managedBy}]` : validProbe.found;
                } else {
                    passed = false;
                    // Just show the first found version we have, if any
                    const primaryProbe = matchingProbes.find(p => p.found);
                    foundStr = primaryProbe ? primaryProbe.found : null;
                    severity = category === 'runtime' ? 'critical' : 'warning';
                }
            }
        }

        checks.push({
            id: `${req.tool}-${req.required || 'any'}`,
            name: req.tool,
            category,
            severity,
            required: req.required,
            found: foundStr,
            passed
        });
    }

    // Unrequested but installed/problematic features (e.g. docker daemon dead, git email missing, nvm mismatch)
    for (const probe of probes) {
        if (probe.tool.includes(':')) {
            // It's a structured error tool (like node:nvm-mismatch, docker:daemon, git:config)
            if (probe.tool !== 'env:local_keys') {
                 checks.push({
                     id: probe.tool,
                     name: probe.tool,
                     category: 'config',
                     severity: 'warning',
                     required: 'properly configured',
                     found: probe.reason || 'misconfigured',
                     passed: false
                 });
            }
        }
    }

    return checks;
}

function satisfiesRequirement(found: string, required: string | null, type: string): boolean {
    if (!required) return true; // no specific version required
    const cleanFound = found.replace(/^[^\d]+/, ''); // remove v from v20 etc
    
    try {
        if (type === 'min') {
            return semver.gte(semver.coerce(cleanFound) || cleanFound, semver.coerce(required) || required);
        } else if (type === 'exact') {
            return semver.eq(semver.coerce(cleanFound) || cleanFound, semver.coerce(required) || required);
        } else if (type === 'semver-range') {
            const range = semver.validRange(required);
            if (range) {
                return semver.satisfies(cleanFound, range);
            }
            return cleanFound.startsWith(required.replace(/[\^~]/g, ''));
        }
    } catch {
        // Fallback for weird versions or non-semver compliant stuff
        return cleanFound.startsWith(required.replace(/[^\d.]/g, ''));
    }
    return true;
}
