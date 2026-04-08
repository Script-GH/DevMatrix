#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import fs from 'fs/promises';
import path from 'path';
import { intro, outro, password, log } from '@clack/prompts';
import chalk from 'chalk';
import { probeSystem } from './scanner/SystemProber.js';
import { detectStack } from './scanner/StackDetector.js';
import { parseEnv } from './scanner/EnvParser.js';
import { computeScore, evaluateEnvironment } from './engine/DiffEngine.js';
import { getAIFixes } from './ai/AIAdvisor.js';
import { runAgentFixer } from './ai/AgentRunner.js';
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

    // 5. Fetch AI Context for Failures
    const aiFixes = await getAIFixes(checks);
    for (const fix of aiFixes) {
        const target = report.checks.find(c => c.id === fix.id);
        if (target) {
            target.explanation = fix.explanation;
            target.reasoning = fix.reasoning;
            target.fixCommand = fix.fixCommand;
            target.risk = fix.risk;
        }
    }
    
    if (options.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        ui.update({ ...report });
        
        // Wait for either exit or fix request
        await Promise.race([
            ui.waitUntilExit(),
            ui.fixRequested().then(async () => {
                // Dashboard unmounted, now run the fixer
                const failures = report.checks.filter(c => !c.passed);
                await runAgentFixer(failures);
            })
        ]);
    }
  });

program.command('fix')
  .description('Automatically fix environment issues using the DevPulse Agent')
  .action(async () => {
    const cwd = process.cwd();
    console.log('Scanning environment...');
    const reqs = await detectStack(cwd);
    const probes = await probeSystem(cwd);
    const checks = evaluateEnvironment(reqs, probes);
    const score = computeScore(checks);
    
    if (score === 100) {
        console.log('Your environment is perfectly configured! No fixes needed.');
        return;
    }
    
    console.log('Analyzing failures with Gemini AI...');
    const aiFixes = await getAIFixes(checks);
    for (const fix of aiFixes) {
        const target = checks.find(c => c.id === fix.id);
        if (target) {
            target.explanation = fix.explanation;
            target.reasoning = fix.reasoning;
            target.fixCommand = fix.fixCommand;
            target.risk = fix.risk;
        }
    }
    
    const failures = checks.filter(c => !c.passed);
    await runAgentFixer(failures);
  });

program.command('auth')
  .description('Configure Gemini API Key persistently')
  .action(async () => {
    intro(chalk.bgBlue.white(' 🔑 DevPulse Authentication '));
    
    const apiKey = await password({
      message: 'Enter your Gemini API Key:',
      validate: (value) => {
        if (!value) return 'API Key is required';
        if (value.length < 20) return 'API Key looks too short';
        return;
      }
    });

    if (typeof apiKey === 'symbol' || !apiKey) {
        outro('Authentication cancelled.');
        return;
    }

    const envPath = path.join(process.cwd(), '.env');
    let content = '';
    try {
        content = await fs.readFile(envPath, 'utf8');
    } catch {
        // file doesn't exist, ignore
    }

    const lines = content.split('\n');
    const existingIndex = lines.findIndex(l => l.startsWith('GEMINI_API_KEY='));
    
    if (existingIndex > -1) {
        lines[existingIndex] = `GEMINI_API_KEY=${apiKey}`;
    } else {
        lines.push(`GEMINI_API_KEY=${apiKey}`);
    }

    await fs.writeFile(envPath, lines.join('\n').trim() + '\n');
    log.success(chalk.green('Successfully saved GEMINI_API_KEY to .env'));
    outro('You are ready to use AI-powered fixes!');
  });


program.command('advice')
  .description('Get AI-driven technical advice for your setup')
  .action(() => {
    console.log('dmx advice: Placeholder for AI advice.');
  });

program.parse();
