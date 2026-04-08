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

async function askToExecute(issue: CheckResult, command: string): Promise<'execute' | 'skip' | 'cancel'> {
    log.message(chalk.yellow(`Proposed Command: ${command}`));
    log.message(chalk.dim(`Auto mode: executing fix for ${issue.id}.`));
    return 'execute';
}

async function askToRetry(): Promise<boolean> {
    log.message(chalk.dim('Auto mode: retrying with AI analysis.'));
    return true;
}

async function executeCommand(command: string, issueId: string): Promise<{ ok: boolean; errorOutput?: string }> {
    const s = spinner();
    s.start(`Executing: ${command}`);

    try {
        await execa(command, { shell: true, all: true });
        s.stop(chalk.green(`Success! Fixed ${issueId}`));
        return { ok: true };
    } catch (err: any) {
        s.stop(chalk.red('Failed to execute command.'));
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

        const executeChoice = await askToExecute(issue, currentCommand);
        if (executeChoice === 'cancel') return 'skipped';
        if (executeChoice === 'skip') {
            log.warn(`Skipped fixing ${issue.id}.`);
            return 'skipped';
        }

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
}
