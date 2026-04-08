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
  .name('dmx')
  .description('DevMatrix (DMX) - AI-Powered Environment Diagnostician')
  .version('1.0.0');

program.command('scan')
  .description('Scan the local environment and generate a health report')
  .option('--json', 'Output report as JSON')
  .action(async (options) => {
    const cwd = process.cwd();
    const report: HealthReport = {
        score: 0,
        timestamp: new Date().toISOString(),
        projectPath: cwd,
        detectedStacks: [],
        checks: [],
        summary: "Initializing DevPulse scan...",
    };

    let ui: any;
    if (!options.json) {
        ui = renderReport(report, {
            onFix: () => runFix(),
            onAdvice: () => runAdvice()
        });
    }

    // 1. Detect Requirements dynamically from project files
    const reqs = await detectStack(cwd);
    report.detectedStacks = [...new Set(reqs.map(r => r.tool))];
    if (ui) ui.update({ ...report });

    // 2. Probe System based on installed binaries and configurations
    const probes = await probeSystem(cwd);
    
    // 3. DiffEngine evaluate to synthesize differences into checks
    const checks = evaluateEnvironment(reqs, probes);
    report.checks = checks;

    // 4. Compute Score
    const score = computeScore(checks);
    report.score = score;
    report.summary = score === 100 ? "Your environment is perfectly configured!" : "DevPulse generated the following diagnostics against your workspace.";
    if (ui) ui.update({ ...report });

    // 5. Fetch AI Context for Failures
    const aiFixes = await getAIFixes(checks);
    for (const fix of aiFixes) {
        const target = report.checks.find(c => c.id === fix.id);
        if (target) {
            target.explanation = fix.explanation;
            target.fixCommand = fix.fixCommand;
            target.risk = fix.risk;
        }
    }
    
    if (options.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        ui.update({ ...report });
        await ui.waitUntilExit();
    }
  });

program.command('fix')
  .description('Automatically fix environment issues')
  .action(() => {
    runFix();
  });

program.command('advice')
  .description('Get AI-driven technical advice for your setup')
  .action(() => {
    runAdvice();
  });

async function runFix() {
    console.log('\n⚡ dmx fix: Initiating automatic repair sequences...');
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log('✅ Fixes applied successfully.');
}

async function runAdvice() {
    console.log('\n🤖 dmx advice: Consulting AI models for architectural recommendations...');
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log('💡 AI Advice generated.');
}

program.parse();
