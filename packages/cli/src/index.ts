#!/usr/bin/env node
import os from 'os';
import dotenv from 'dotenv';
import { Command } from 'commander';
import fs from 'fs/promises';
import path from 'path';
import { intro, outro, password, log, spinner } from '@clack/prompts';
import chalk from 'chalk';

import { probeSystem }         from './scanner/SystemProber.js';
import { detectStack }         from './scanner/StackDetector.js';
import { parseEnv }            from './scanner/EnvParser.js';
import { computeScore, evaluateEnvironment } from './engine/DiffEngine.js';
import { runAgentFixer }       from './ai/AgentRunner.js';
import { renderReport }        from './render/TerminalUI.js';
import { getAIFixes, getTechnicalAdvice } from './ai/AIAdvisor.js';
import { HealthReport }        from '@devpulse/shared';
import {
  cmdAddDev, cmdUpdateList, cmdUpdateOfficial, cmdUpdateFrom,
  cmdStatus, cmdLogsPush, cmdListDevs, cmdLink,
  cmdRemoveProject, cmdProjectInfo,
} from './commands.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG_DIR      = path.join(os.homedir(), '.devpulse');
const CONFIG_ENV_PATH = path.join(CONFIG_DIR, '.env');

dotenv.config({ path: CONFIG_ENV_PATH, quiet: true } as any);
dotenv.config({ quiet: true } as any);

// ─── Shared types ─────────────────────────────────────────────────────────────

type ScanContext = {
  cwd:            string;
  checks:         HealthReport['checks'];
  score:          number;
  detectedStacks: string[];
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Restore stdin to a normal readable state after ink exits.
 * ink puts stdin in raw mode; if the process continues (agent runner,
 * advice mode) we need cooked mode back so prompts work correctly.
 */
function restoreStdin(): void {
  try {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode?.(false);
    }
    process.stdin.resume();
  } catch {
    // best-effort — never crash on cleanup
  }
}

/**
 * Build the full environment scan context.
 * Runs StackDetector, SystemProber, and EnvParser in parallel.
 */
async function buildScanContext(cwd: string): Promise<ScanContext> {
  const entries = await fs.readdir(cwd, { withFileTypes: true }).catch(() => []);
  const subdirs = entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map(e => path.join(cwd, e.name));

  const [reqs, probes, envParseResults] = await Promise.all([
    detectStack(cwd),
    probeSystem(cwd),
    parseEnv(cwd, subdirs),
  ]);

  const envKeys = envParseResults.flatMap(r => r.keys);
  const checks  = evaluateEnvironment(reqs, probes, envKeys);
  const score   = computeScore(checks);
  const detectedStacks = [...new Set(reqs.map(r => r.tool))];

  return { cwd, checks, score, detectedStacks };
}

/**
 * Merge AI-generated fix data into existing check results in-place.
 * Only updates fields that the AI returned — never overwrites unrelated fields.
 */
function mergeAIFixes(
  checks:  HealthReport['checks'],
  aiFixes: Partial<HealthReport['checks'][number]>[],
): void {
  for (const fix of aiFixes) {
    const target = checks.find(c => c.id === fix.id);
    if (!target) continue;
    if (fix.explanation !== undefined) target.explanation = fix.explanation;
    if (fix.reasoning   !== undefined) target.reasoning   = fix.reasoning;
    if (fix.fixCommand  !== undefined) target.fixCommand  = fix.fixCommand;
    if (fix.risk        !== undefined) target.risk        = fix.risk;
  }
}

/**
 * Build a HealthReport summary string based on score.
 */
function buildSummary(score: number): string {
  if (score === -1) return 'No project requirements detected. Is this the project root?';
  if (score === 100) return 'Your environment is perfectly configured!';
  return 'DevPulse generated diagnostics against your workspace.';
}

// ─── CLI setup ────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('dmx')
  .description('DevMatrix (DMX) — AI-Powered Environment Diagnostician')
  .version('1.0.0');

// ─── scan ─────────────────────────────────────────────────────────────────────

program
  .command('scan')
  .description('Scan the local environment and generate a health report')
  .option('--json', 'Output report as JSON')
  .action(async (options) => {
    const cwd = process.cwd();

    // ── JSON mode — no UI, just data ─────────────────────────────────────────
    if (options.json) {
      const context = await buildScanContext(cwd);
      const aiFixes = await getAIFixes(context.checks.filter(c => !c.passed));
      mergeAIFixes(context.checks, aiFixes);

      const report: HealthReport = {
        score:          context.score === -1 ? 0 : context.score,
        timestamp:      new Date().toISOString(),
        projectPath:    cwd,
        detectedStacks: context.detectedStacks,
        checks:         context.checks,
        summary:        buildSummary(context.score),
      };

      console.log(JSON.stringify(report, null, 2));
      return;
    }

    // ── Interactive mode ─────────────────────────────────────────────────────

    // 1. Start UI immediately in 'scanning' phase — user sees activity at once
    const emptyReport: HealthReport = {
      score: 0, timestamp: new Date().toISOString(),
      projectPath: cwd, detectedStacks: [], checks: [], summary: '',
    };

    const ui = renderReport(emptyReport, 'scanning');

    // 2. Run all scanners
    const context = await buildScanContext(cwd);
    const safeScore = context.score === -1 ? 0 : context.score;

    const report: HealthReport = {
      score:          safeScore,
      timestamp:      new Date().toISOString(),
      projectPath:    cwd,
      detectedStacks: context.detectedStacks,
      checks:         context.checks,
      summary:        buildSummary(context.score),
    };

    // 3. Show scan results while AI fetches — user can read checks immediately
    ui.updateReport(report, 'ai-loading');

    // 4. Fetch AI fixes (async, UI stays interactive)
    const failedChecks = report.checks.filter(c => !c.passed);
    if (failedChecks.length > 0) {
      const aiFixes = await getAIFixes(failedChecks);
      mergeAIFixes(report.checks, aiFixes);
    }

    // 5. Fully ready — user can now press F / A / Q
    ui.updateReport(report, 'ready');

    // 6. Wait for user to act — this is the ONLY await on user input.
    //    actionPromise resolves after the 280ms "Handing off..." feedback delay,
    //    so the user always sees the exit message before the UI tears down.
    const action = await ui.actionPromise;

    // 7. Ink has already scheduled its exit; give it one tick to flush
    await new Promise(r => setImmediate(r));

    // 8. Restore stdin BEFORE any follow-up interactive commands
    restoreStdin();

    // 9. Dispatch post-UI action
    if (action === 'fix') {
      await runFix(report);
    } else if (action === 'advice') {
      await runAdvice();
    }
    // 'quit' — fall through, process exits naturally

    // 10. Await final snapshot push if project is tracked
    try { await tryPushSnapshot(); } catch { /* silent */ }

    // 11. Force a clean exit to close dangling Supabase/network handles
    process.exit(0);
  });

// ─── fix ──────────────────────────────────────────────────────────────────────

program
  .command('fix')
  .description('Automatically fix environment issues using the DevPulse agent')
  .action(async () => {
    const context = await buildScanContext(process.cwd());

    if (context.score === 100) {
      console.log(chalk.green('✓ Environment is perfectly configured — nothing to fix.'));
      return;
    }

    const aiFixes = await getAIFixes(context.checks.filter(c => !c.passed));
    mergeAIFixes(context.checks, aiFixes);

    await runFix({
      score:          context.score,
      timestamp:      new Date().toISOString(),
      projectPath:    context.cwd,
      detectedStacks: context.detectedStacks,
      checks:         context.checks,
      summary:        buildSummary(context.score),
    });

    process.exit(0);
  });

// ─── advice ───────────────────────────────────────────────────────────────────

program
  .command('advice')
  .description('Get AI-driven technical advice for your setup')
  .option('--raw', 'Output raw markdown without UI rendering')
  .action(async (options) => {
    await runAdvice(options);
    process.exit(0);
  });

// ─── auth ─────────────────────────────────────────────────────────────────────

program
  .command('auth')
  .description('Configure Groq API key (stored in ~/.devpulse/.env)')
  .action(async () => {
    intro(chalk.bgBlue.white(' DevPulse Authentication '));

    const apiKey = await password({
      message: 'Enter your Groq API Key:',
      validate: (value) => {
        if (!value)        return 'API key is required';
        if (value.length < 20) return 'API key looks too short';
      },
    });

    if (typeof apiKey === 'symbol' || !apiKey) {
      outro('Authentication cancelled.');
      return;
    }

    await fs.mkdir(CONFIG_DIR, { recursive: true });

    let existing = '';
    try { existing = await fs.readFile(CONFIG_ENV_PATH, 'utf8'); } catch {}

    const lines = existing.split('\n').filter(Boolean);
    const idx   = lines.findIndex(l => l.startsWith('GROQ_API_KEY='));
    const entry = `GROQ_API_KEY=${apiKey}`;

    if (idx > -1) lines[idx] = entry;
    else          lines.push(entry);

    await fs.writeFile(CONFIG_ENV_PATH, lines.join('\n') + '\n');
    log.success(chalk.green(`API key saved to ${CONFIG_ENV_PATH}`));
    outro('Run `dmx scan` from any project directory.');
  });

// ─── init / add / update / status / logs / list / project / link / remove ─────

program
  .command('init <projectId>')
  .description('Initialize DMX project tracking in the current directory')
  .action((projectId) => cmdAddDev(projectId));

const addCmd = program.command('add').description('Register resources with DevMatrix');
addCmd
  .command('dev <projectId>')
  .description('Initialize DMX project tracking (alias for init)')
  .action((projectId) => cmdAddDev(projectId));

program
  .command('update')
  .argument('[devName]', 'Developer name, or "list" to preview changes')
  .description('Sync dependencies with the project or a team member')
  .action(async (devName?: string) => {
    if (devName === 'list')  await cmdUpdateList();
    else if (!devName)       await cmdUpdateOfficial();
    else                     await cmdUpdateFrom(devName);
  });

program
  .command('status')
  .description('Compare local deps against official project state and team max')
  .action(cmdStatus);

const logsCmd = program.command('logs').description('Manage version timeline logs');
logsCmd.command('push').description('Push current versions to the project timeline').action(cmdLogsPush);

const listCmd = program.command('list').description('List project resources');
listCmd.command('devs').description('List registered developers for the current project').action(cmdListDevs);

const projectCmd = program.command('project').description('Manage project-specific data');
projectCmd
  .command('info')
  .description('Fetch project details and team list')
  .option('--json', 'Output as JSON')
  .action(cmdProjectInfo);

// Alias kept for backwards compat
program
  .command('project-info', { hidden: true })
  .description('Alias for `project info`')
  .option('--json', 'Output as JSON')
  .action(cmdProjectInfo);

program
  .command('link <webToken>')
  .description('Link this CLI to your DMX web account')
  .action(cmdLink);

program
  .command('remove')
  .description('Remove project tracking association from this machine')
  .action(cmdRemoveProject);

// ─── Shared action implementations ────────────────────────────────────────────

/**
 * runFix — handed a fully-populated report (with AI fixes already merged).
 * Runs the agent fixer against all failing checks.
 * Called both from `scan` (post-UI) and standalone `fix` command.
 */
async function runFix(report: HealthReport): Promise<void> {
  const failures = report.checks.filter(c => !c.passed);
  if (failures.length === 0) {
    console.log(chalk.green('✓ No issues to fix.'));
    return;
  }
  await runAgentFixer(failures);
}

/**
 * runAdvice — fetches and renders AI architectural advice.
 * Supports --raw flag for pipe-friendly output.
 */
async function runAdvice(options: { raw?: boolean } = {}): Promise<void> {
  const isRaw = options.raw ?? false;
  let s: ReturnType<typeof spinner> | null = null;

  if (!isRaw) {
    intro(chalk.bgCyan.black(' DevPulse Architecture Advice '));
    s = spinner();
    s.start('Consulting Groq AI with environment context...');
  }

  try {
    const context = await buildScanContext(process.cwd());
    const adviceRaw = await getTechnicalAdvice(context.checks);
    const advice = adviceRaw?.trim() || 'No advice returned. Please try again.';

    if (isRaw) {
      console.log(advice);
      return;
    }

    s?.stop('Advice report generated.');
    renderAdviceBox(advice);
    outro(chalk.bold.bgGreen.black(' ARCHITECTURAL REVIEW COMPLETE '));
  } catch (err: any) {
    if (isRaw) {
      console.error(err.message);
      return;
    }
    s?.stop(chalk.red('Failed to generate advice.'));
    log.error(err.message);
  }
}

/**
 * Render advice text in a chalk box — extracted so it's testable.
 */
function renderAdviceBox(advice: string): void {
  const MAX = 80;
  const bar = '─'.repeat(MAX + 2);

  function wrapLine(line: string): string[] {
    const words = line.split(' ');
    const out: string[] = [];
    let cur = '';
    for (const word of words) {
      if (!cur) {
        cur = word;
      } else if (cur.length + 1 + word.length <= MAX) {
        cur += ' ' + word;
      } else {
        out.push(cur);
        cur = word;
      }
    }
    if (cur) out.push(cur);
    return out.length ? out : [''];
  }

  console.log('\n' + chalk.cyan(`╭${bar}╮`));
  for (const line of advice.split('\n')) {
    for (const wrapped of wrapLine(line)) {
      console.log(chalk.cyan('│ ') + chalk.white(wrapped.padEnd(MAX)) + chalk.cyan(' │'));
    }
  }
  console.log(chalk.cyan(`╰${bar}╯`) + '\n');
}

/**
 * Fire-and-forget snapshot push.
 * Only runs if the project has been initialised with `dmx init`.
 */
async function tryPushSnapshot(): Promise<void> {
  const { readLocalConfig } = await import('./utils/config.js');
  const cfg = await readLocalConfig();
  if (cfg.projectId) await cmdLogsPush();
}

// ─── Entry ────────────────────────────────────────────────────────────────────

program.parse();