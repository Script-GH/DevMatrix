#!/usr/bin/env node
import { Command } from 'commander';
import { probeSystem } from './scanner/SystemProber.js';
import { detectStack } from './scanner/StackDetector.js';
import { computeScore, evaluateEnvironment } from './engine/DiffEngine.js';
import { getAIFixes } from './ai/AIAdvisor.js';
import { renderReport } from './render/TerminalUI.js';
import { HealthReport } from '@devpulse/shared';

const program = new Command();

program
  .name('devpulse')
  .description('AI-Powered Environment Diagnostician')
  .version('1.0.0');

program.command('scan')
  .description('Scan the local environment and generate a health report')
  .action(async () => {
    const cwd = process.cwd();
    
    // 1. Detect Requirements dynamically from project files
    const reqs = await detectStack(cwd);

    // 2. Probe System based on installed binaries and configurations
    const probes = await probeSystem(cwd);
    
    // 3. DiffEngine evaluate to synthesize differences into checks
    const checks = evaluateEnvironment(reqs, probes);

    // 4. Compute Score
    const score = computeScore(checks);

    // 5. Fetch AI Context for Failures
    const aiFixes = await getAIFixes(checks);
    for (const fix of aiFixes) {
        const target = checks.find(c => c.id === fix.id);
        if (target) {
            target.explanation = fix.explanation;
            target.fixCommand = fix.fixCommand;
            target.risk = fix.risk;
        }
    }

    // 6. Render the output report
    const report: HealthReport = {
        score,
        timestamp: new Date().toISOString(),
        projectPath: cwd,
        detectedStacks: [...new Set(reqs.map(r => r.tool))],
        checks,
        summary: score === 100 ? "Your environment is perfectly configured!" : "DevPulse generated the following diagnostics against your workspace.",
    };

    await renderReport(report);
  });

program.parse();
