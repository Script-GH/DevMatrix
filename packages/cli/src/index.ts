#!/usr/bin/env node
import os from 'os';
import dotenv from 'dotenv';
import { Command } from 'commander';
import fs from 'fs/promises';
import path from 'path';
import { intro, outro, password, log, spinner } from '@clack/prompts';
import chalk from 'chalk';
import { probeSystem } from './scanner/SystemProber.js';
import { detectStack } from './scanner/StackDetector.js';
import { parseEnv } from './scanner/EnvParser.js';
import { computeScore, evaluateEnvironment } from './engine/DiffEngine.js';
import { runAgentFixer } from './ai/AgentRunner.js';
import { renderReport } from './render/TerminalUI.js';
import { getAIFixes, getTechnicalAdvice } from './ai/AIAdvisor.js';
import { HealthReport } from '@devpulse/shared';

const CONFIG_DIR = path.join(os.homedir(), '.devpulse');
const CONFIG_ENV_PATH = path.join(CONFIG_DIR, '.env');

dotenv.config({ path: CONFIG_ENV_PATH });
dotenv.config();

const program = new Command();

type ScanContext = {
  cwd: string;
  checks: HealthReport['checks'];
  score: number;
  detectedStacks: string[];
};

function restoreInteractiveStdin() {
  try {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode?.(false);
      process.stdin.resume();
    }
  } catch {
    // Best effort only.
  }
}

async function settleInputHandoff() {
  await new Promise((resolve) => setTimeout(resolve, 80));
}

async function buildScanContext(cwd: string): Promise<ScanContext> {
  const entries = await fs.readdir(cwd, { withFileTypes: true }).catch(() => []);
  const subdirs = entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map(e => path.join(cwd, e.name));

  const [reqs, probes, envParseResults] = await Promise.all([
    detectStack(cwd),
    probeSystem(cwd),
    parseEnv(cwd, subdirs)
  ]);

  const envKeys = envParseResults.flatMap(r => r.keys);
  const checks = evaluateEnvironment(reqs, probes, envKeys);
  const score = computeScore(checks);
  const detectedStacks = [...new Set(reqs.map(r => r.tool))];

  return { cwd, checks, score, detectedStacks };
}

function mergeAIFixesIntoChecks(checks: HealthReport['checks'], aiFixes: Partial<HealthReport['checks'][number]>[]) {
  for (const fix of aiFixes) {
    const target = checks.find(c => c.id === fix.id);
    if (!target) continue;
    target.explanation = fix.explanation;
    target.reasoning = fix.reasoning;
    target.fixCommand = fix.fixCommand;
    target.risk = fix.risk;
  }
}

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

    let pendingAction: 'fix' | 'advice' | null = null;

    let ui: any;
    if (!options.json) {
      ui = renderReport(report, {
        onFix: () => { pendingAction = 'fix'; },
        onAdvice: () => { pendingAction = 'advice'; }
      });
    }

    const context = await buildScanContext(cwd);
    report.detectedStacks = context.detectedStacks;
    report.checks = context.checks;
    const score = context.score;
    report.score = score === -1 ? 0 : score;
    report.summary = score === -1
      ? "No project requirements detected. Is this the project root?"
      : score === 100
        ? "Your environment is perfectly configured!"
        : "DevPulse generated diagnostics against your workspace.";

    if (ui) ui.update({ ...report });

    const failedChecks = report.checks.filter(c => !c.passed);
    if (failedChecks.length > 0) {
      const aiFixes = await getAIFixes(failedChecks);
      mergeAIFixesIntoChecks(report.checks, aiFixes);
    }

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    ui.update({ ...report });
    await ui.waitUntilExit();

    restoreInteractiveStdin();
    await settleInputHandoff();

    if (pendingAction === 'fix') {
      const failures = report.checks.filter(c => !c.passed);
      await runAgentFixer(failures);
    } else if (pendingAction === 'advice') {
      await runAdvice();
    }
  });

program.command('fix')
  .description('Automatically fix environment issues using the DevPulse Agent')
  .action(runFix);

program.command('advice')
  .description('Get AI-driven technical advice for your setup')
  .action(runAdvice);

program.command('auth')
  .description('Configure Groq API Key persistently (stored in ~/.devpulse/.env)')
  .action(async () => {
    intro(chalk.bgBlue.white(' DevPulse Authentication '));

    const apiKey = await password({
      message: 'Enter your Groq API Key:',
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

    await fs.mkdir(CONFIG_DIR, { recursive: true });

    let content = '';
    try {
      content = await fs.readFile(CONFIG_ENV_PATH, 'utf8');
    } catch {
      // file does not exist yet
    }

    const lines = content.split('\n').filter(Boolean);
    const existingIndex = lines.findIndex(l => l.startsWith('GROQ_API_KEY='));

    if (existingIndex > -1) {
      lines[existingIndex] = `GROQ_API_KEY=${apiKey}`;
    } else {
      lines.push(`GROQ_API_KEY=${apiKey}`);
    }

    await fs.writeFile(CONFIG_ENV_PATH, lines.join('\n') + '\n');
    log.success(chalk.green(`GROQ_API_KEY saved to ${CONFIG_ENV_PATH}`));
    outro('You are ready to use AI fixes. Run `dmx scan` from anywhere.');
  });

async function runFix() {
  const cwd = process.cwd();
  const context = await buildScanContext(cwd);
  const checks = context.checks;
  const score = context.score;
  if (score === 100) {
    console.log(chalk.green('Environment perfectly configured. No fixes needed.'));
    return;
  }

  const aiFixes = await getAIFixes(checks.filter(c => !c.passed));
  mergeAIFixesIntoChecks(checks, aiFixes);

  const failures = checks.filter(c => !c.passed);
  await runAgentFixer(failures);
}

async function runAdvice() {
  intro(chalk.bgCyan.black(' DevPulse Architecture Advice '));
  const s = spinner();
  s.start('Consulting Groq AI with environment context...');

  try {
    const context = await buildScanContext(process.cwd());
    const adviceRaw = await getTechnicalAdvice(context.checks);
    const advice = adviceRaw?.trim()
      ? adviceRaw
      : 'No advice was returned by AI for this run. Please try again.';
    s.stop('Advice report generated.');

    const divider = '─'.repeat(82);
    console.log('\n' + chalk.cyan.bold(`╭${divider}╮`));

    const maxLen = 80;
    const wrapText = (text: string) => {
      const words = text.split(' ');
      const lines: string[] = [];
      let currentLine = '';
      for (const word of words) {
        if (!currentLine) {
          currentLine = word;
        } else if (currentLine.length + word.length + 1 <= maxLen) {
          currentLine += ' ' + word;
        } else {
          lines.push(currentLine);
          currentLine = word;
        }
      }
      if (currentLine) lines.push(currentLine);
      return lines;
    };

    advice.split('\n').forEach(line => {
      const wrappedLines = wrapText(line);
      wrappedLines.forEach(wrapped => {
        console.log(chalk.cyan('│ ') + chalk.white(wrapped.padEnd(maxLen)) + chalk.cyan(' │'));
      });
    });
    console.log(chalk.cyan(`╰${divider}╯`) + '\n');

    outro(chalk.bold.bgGreen.black(' ARCHITECTURAL REVIEW COMPLETE '));
  } catch (err: any) {
    s.stop(chalk.red('Failed to generate advice.'));
    log.error(err.message);
  }
}

program.parse();
