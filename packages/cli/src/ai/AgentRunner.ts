import { intro, outro, spinner, log } from '@clack/prompts';
import { execa } from 'execa';
import { CheckResult } from '@devpulse/shared';
import { getRemedyForError } from './AIAdvisor.js';
import chalk from 'chalk';

type FixOutcome = 'fixed' | 'skipped' | 'failed';

type FixStats = {
    fixed: number;
    skipped: number;
    failed: number;
};

const MAX_ATTEMPTS = 3;

async function askToRetry(): Promise<boolean> {
    // Automatically retry if a command fails
    return true;
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

        // Auto-executing without manual review as requested by user
        log.message(chalk.yellow(`Agent is auto-executing: ${currentCommand}`));
        
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
        // clack cleans up its own listeners
    }
}
