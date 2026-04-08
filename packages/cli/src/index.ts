#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'fs/promises';
import path from 'path';
import { probeSystem } from './scanner/SystemProber.js';
import { detectStack } from './scanner/StackDetector.js';
import { parseEnv } from './scanner/EnvParser.js';
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

    // 1. Parallel Discovery & Scanning
    // Discovery subdirs (matching StackDetector logic)
    const entries = await fs.readdir(cwd, { withFileTypes: true }).catch(() => []);
    const subdirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
        .map(e => path.join(cwd, e.name));

    // Run all scanners in parallel for maximum performance
    const [reqs, probes, envParseResults] = await Promise.all([
        detectStack(cwd),
        probeSystem(cwd),
        parseEnv(cwd, subdirs)
    ]);

    report.detectedStacks = [...new Set(reqs.map(r => r.tool))];
    
    // 2. DiffEngine evaluate
    const envKeys = envParseResults.flatMap(r => r.keys);
    const checks = evaluateEnvironment(reqs, probes, envKeys);
    report.checks = checks;

    // 3. Compute Score
    const score = computeScore(checks);
    report.score = score;
    if (score === -1) {
        report.score = 0;
        report.summary = "No project requirements detected. Is this the project root?";
    } else {
        report.summary = score === 100 ? "Your environment is perfectly configured!" : "DevPulse generated diagnostics against your workspace.";
    }
    
    if (ui) ui.update({ ...report });

    // 4. Fetch AI Context for Failures
    const failedChecks = checks.filter(c => !c.passed);
    if (failedChecks.length > 0) {
        const aiFixes = await getAIFixes(failedChecks);
        for (const fix of aiFixes) {
            const target = report.checks.find(c => c.id === fix.id);
            if (target) {
                target.explanation = fix.explanation;
                target.fixCommand = fix.fixCommand;
                target.risk = fix.risk;
            }
        }
    }
    
    if (options.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        ui.update({ ...report });
        await ui.waitUntilExit();
    }
  });

program.command('fix').action(runFix);
program.command('advice').action(runAdvice);

async function runFix() { 
    console.log('\n⚡ dmx fix: Initiating automatic repair...');
    await new Promise(r => setTimeout(r, 1000));
}

async function runAdvice() {
    console.log('\n🤖 dmx advice: Consulting AI...');
    await new Promise(r => setTimeout(r, 1000));
}

program.parse();
