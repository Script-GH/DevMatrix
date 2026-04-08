import { intro, outro, spinner, select, log } from '@clack/prompts';
import { execa } from 'execa';
import { CheckResult } from '@devpulse/shared';
import { getRemedyForError } from './AIAdvisor.js';
import chalk from 'chalk';

export async function runAgentFixer(failures: CheckResult[]) {
    intro(chalk.bgBlue.white(' DevPulse Agentic Fixer '));

    if (failures.length === 0) {
        log.success('No issues to fix! Your environment is perfectly configured.');
        outro('Agent finished.');
        return;
    }

    log.warn(`Found ${failures.length} issues requiring attention.`);

    for (const issue of failures) {
        log.info(chalk.bold.bgCyan.black(` ISSUE: ${issue.name} `));

        if (issue.reasoning) {
            log.step(chalk.dim('Agent Reasoning:'));
            log.message(chalk.italic(issue.reasoning));
        }

        log.message(`${chalk.bold('Goal:')} ${issue.explanation || 'Fix the environment discrepancy.'}`);

        let currentCommand = issue.fixCommand;
        let attempts = 0;
        const MAX_ATTEMPTS = 3;
        let fixed = false;

        while (attempts < MAX_ATTEMPTS && !fixed) {
            attempts++;
            if (!currentCommand) {
                log.error(`Agent couldn't determine a fix command. Skipping...`);
                break;
            }

            log.message(chalk.yellow(`Proposed Command: ${currentCommand}`));

            const choice = await select({
                message: `Execute this command to fix ${issue.id}?`,
                options: [
                    { value: true, label: 'Yes', hint: 'recommended' },
                    { value: false, label: 'No' }
                ],
                initialValue: true
            });

            if (!choice || typeof choice === 'symbol') {
                log.warn(`Skipped fixing ${issue.id}.`);
                break;
            }

            const s = spinner();
            s.start(`Executing: ${currentCommand}`);

            try {
                await execa(currentCommand, { shell: true, all: true });
                s.stop(chalk.green(`Success! Fixed ${issue.id}`));
                fixed = true;
            } catch (err: any) {
                s.stop(chalk.red(`Failed to execute command.`));
                const errorOutput = err.all || err.stderr || err.message;
                log.error(`Error Output:\n${chalk.gray(errorOutput)}`);

                if (attempts < MAX_ATTEMPTS) {
                    const retry = await select({
                        message: `Command failed. Do you want the Agent to analyze the error and try a new command?`,
                        options: [
                            { value: true, label: 'Retry with AI analysis', hint: 'recommended' },
                            { value: false, label: 'Skip this issue' }
                        ],
                        initialValue: true
                    });

                    if (retry && typeof retry !== 'symbol') {
                        const loadingAi = spinner();
                        loadingAi.start('Agent is reasoning about the error...');
                        const newCmd = await getRemedyForError(issue, errorOutput);
                        loadingAi.stop('Generated new fix strategy.');

                        if (newCmd && newCmd.fixCommand) {
                            currentCommand = newCmd.fixCommand;
                            log.step(chalk.magenta('Agent updated its strategy:'));
                            if (newCmd.reasoning) log.message(chalk.dim.italic(newCmd.reasoning));
                            log.message(`${chalk.bold('Revised Goal:')} ${newCmd.explanation}`);
                        } else {
                            log.error('Agent could not formulate a new command.');
                            break;
                        }
                    } else {
                        break;
                    }
                } else {
                    log.error(`Max retries reached for ${issue.id}.`);
                }
            }
        }
    }

    outro(chalk.bold.green('Agent finished all fix attempts! Run `dmx scan` again to verify.'));
}
