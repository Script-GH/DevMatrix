import { intro, outro, spinner, log } from '@clack/prompts';
import { execa } from 'execa';
import { CheckResult } from '@devpulse/shared';
import { getRemedyForError } from './AIAdvisor.js';
import chalk from 'chalk';
import fs from 'fs';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { Interface } from 'node:readline/promises';

type FixOutcome = 'fixed' | 'skipped' | 'failed';

type FixStats = {
    fixed: number;
    skipped: number;
    failed: number;
};

const MAX_ATTEMPTS = 3;

type ReviewDecision = 'approve' | 'reject';
let promptRl: Interface | null = null;
let ttyFd: number | null = null;

function normalizeStdinForPrompts() {
    try {
        if (input.isTTY) {
            input.setRawMode?.(false);
            input.resume();
        }
    } catch {
        // Best effort.
    }
}

function getPromptInterface(): Interface {
    if (promptRl) return promptRl;

    if (fs.existsSync('/dev/tty')) {
        ttyFd = fs.openSync('/dev/tty', 'r+');
        const ttyInput = fs.createReadStream('', { fd: ttyFd, autoClose: false });
        const ttyOutput = fs.createWriteStream('', { fd: ttyFd, autoClose: false });
        promptRl = createInterface({ input: ttyInput, output: ttyOutput, terminal: true });
        return promptRl;
    }

    promptRl = createInterface({ input, output, terminal: true });
    return promptRl;
}

function closePromptInterface() {
    try {
        promptRl?.close();
    } catch {
        // ignore
    }
    promptRl = null;
    if (ttyFd !== null) {
        try {
            fs.closeSync(ttyFd);
        } catch {
            // ignore
        }
        ttyFd = null;
    }
}

async function readLine(message: string): Promise<string | null> {
    normalizeStdinForPrompts();
    try {
        const rl = getPromptInterface();
        const answer = await rl.question(message);
        return answer.trim();
    } catch {
        return null;
    }
}

async function reviewCommand(command: string): Promise<{ decision: ReviewDecision; command: string }> {
    log.message(chalk.dim('Review command before execution:'));
    log.message(chalk.yellow(`  ${command}`));
    log.message(chalk.dim('[a] Approve  [r] Reject'));

    const choice = (await readLine('Choice (a/r): '))?.toLowerCase();
    if (!choice || choice === 'r' || choice === 'reject') return { decision: 'reject', command };

    return { decision: 'approve', command };
}

async function askToExecute(issue: CheckResult, command: string): Promise<{ action: 'execute' | 'skip' | 'cancel'; command: string }> {
    log.message(chalk.yellow(`Proposed Command: ${command}`));
    const review = await reviewCommand(command);

    if (review.decision === 'reject') {
        log.warn(`Rejected fix command for ${issue.id}.`);
        return { action: 'skip', command };
    }

    return { action: 'execute', command: review.command };
}

async function askToRetry(): Promise<boolean> {
    const answer = (await readLine('Command failed. Retry with AI analysis? [Y/n]: '))?.toLowerCase();
    if (!answer) return true;
    return answer !== 'n' && answer !== 'no';
}

async function executeCommand(command: string, issueId: string): Promise<{ ok: boolean; errorOutput?: string }> {
    log.step(chalk.cyan(`Running: ${command}`));
    try {
        // Stream command output directly so long-running installs do not look frozen.
        await execa(command, { shell: true, stdio: 'inherit' });
        log.success(chalk.green(`Success! Fixed ${issueId}`));
        return { ok: true };
    } catch (err: any) {
        log.error(chalk.red('Failed to execute command.'));
        const errorOutput = String(err?.all || err?.stderr || err?.message || 'Unknown command error');
        log.error(`Error Output:\n${chalk.gray(errorOutput)}`);
        return { ok: false, errorOutput };
    }
}

async function processIssue(issue: CheckResult): Promise<FixOutcome> {
    log.info(chalk.bold.bgCyan.black(` ISSUE: ${issue.name} `));
    if (issue.reasoning) {
        log.step(chalk.dim('Agent Reasoning:'));
        log.message(chalk.italic(issue.reasoning));
    }
    log.message(`${chalk.bold('Goal:')} ${issue.explanation || 'Fix the environment discrepancy.'}`);

    let currentCommand = issue.fixCommand;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (!currentCommand) {
            log.error("Agent couldn't determine a fix command. Skipping...");
            return 'failed';
        }

        const review = await askToExecute(issue, currentCommand);
        if (review.action === 'cancel') return 'skipped';
        if (review.action === 'skip') {
            log.warn(`Skipped fixing ${issue.id}.`);
            return 'skipped';
        }

        currentCommand = review.command;
        const result = await executeCommand(currentCommand, issue.id);
        if (result.ok) return 'fixed';

        if (attempt >= MAX_ATTEMPTS) {
            log.error(`Max retries reached for ${issue.id}.`);
            return 'failed';
        }

        const shouldRetry = await askToRetry();
        if (!shouldRetry) return 'skipped';

        const loadingAi = spinner();
        loadingAi.start('Agent is reasoning about the error...');
        const remediation = await getRemedyForError(issue, result.errorOutput || 'Unknown execution error');
        loadingAi.stop('Generated new fix strategy.');

        if (!remediation?.fixCommand) {
            log.error('Agent could not formulate a new command.');
            return 'failed';
        }

        currentCommand = remediation.fixCommand;
        log.step(chalk.magenta('Agent updated its strategy:'));
        if (remediation.reasoning) log.message(chalk.dim.italic(remediation.reasoning));
        log.message(`${chalk.bold('Revised Goal:')} ${remediation.explanation || 'Try an alternative remediation strategy.'}`);
    }

    return 'failed';
}

export async function runAgentFixer(failures: CheckResult[]) {
    intro(chalk.bgBlue.white(' DevPulse Agentic Fixer '));

    if (failures.length === 0) {
        log.success('No issues to fix! Your environment is perfectly configured.');
        outro('Agent finished.');
        return;
    }

    try {
        log.warn(`Found ${failures.length} issues requiring attention.`);
        const stats: FixStats = { fixed: 0, skipped: 0, failed: 0 };

        for (const issue of failures) {
            const outcome = await processIssue(issue);
            stats[outcome] += 1;
        }

        log.step(
            `Results: ${chalk.green(`${stats.fixed} fixed`)}, ` +
            `${chalk.yellow(`${stats.skipped} skipped`)}, ` +
            `${chalk.red(`${stats.failed} failed`)}`
        );
        outro(chalk.bold.green('Agent finished all fix attempts! Run `dmx scan` again to verify.'));
    } finally {
        closePromptInterface();
    }
}
