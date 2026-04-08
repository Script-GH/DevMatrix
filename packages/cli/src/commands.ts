/**
 * DMX Collaborative Command Handlers
 *
 * Commands:
 *   dmx add dev <projectId>    — Join a project and register your system
 *   dmx update list            — Fetch official latest; notify of outdated deps
 *   dmx update [devName]       — Sync versions from a specific team member
 *   dmx status                 — Compare local vs Official vs Team Max
 *   dmx logs push              — Snapshot current versions to Supabase timeline
 *   dmx list devs              — List all registered developers
 *   dmx link <webToken>        — Link this CLI to your DMX web account
 */

import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { execa } from 'execa';
import chalk from 'chalk';
import { log, spinner } from '@clack/prompts';
import semver from 'semver';

import { readLocalConfig, writeLocalConfig, LocalConfig, writeProjectConfig, deleteProjectConfig } from './utils/config.js';
import { maskEnvVariables } from './utils/env.js';
import { getDependencyDiff } from './engine/DiffEngine.js';
import type { DependencyDiff } from './engine/DiffEngine.js';
import { detectStack, requirementsToDependencyMap } from './scanner/StackDetector.js';
import type { DependencyMap } from './scanner/StackDetector.js';
import { parseEnv } from './scanner/EnvParser.js';
import {
  upsertDeveloper,
  getDeveloper,
  getAllDevelopers,
  getProjectLatestUpdate,
  updateProjectState,
  pushVersionSnapshot,
  createNotification,
  deleteDeveloper,
} from './utils/supabase.js';


// ─── Core: Unified dependency scanner ───────────────────────────────────────

/**
 * Single entry-point for dependency detection used by ALL cloud commands.
 * Calls the full StackDetector engine (package.json, requirements.txt,
 * pyproject.toml, .env.example, Gemfile, go.mod, Docker, etc.) and converts
 * the results to a flat DependencyMap.
 */
async function scanLocalDeps(cwd: string): Promise<DependencyMap> {
  const reqs = await detectStack(cwd);
  return requirementsToDependencyMap(reqs);
}

/**
 * Extracts only the bare npm package names from a unified DependencyMap.
 * Used when reading/writing package.json (other entries like runtime:node
 * or env:PORT are not valid npm package names).
 */
function extractNpmDeps(depMap: DependencyMap): DependencyMap {
  const result: DependencyMap = {};
  for (const [key, val] of Object.entries(depMap)) {
    if (!key.includes(':')) result[key] = val;
  }
  return result;
}

/**
 * Collects a masked env snapshot using the production EnvParser.
 * Reads .env.example / .env.schema / Docker Compose to discover keys,
 * then checks all .env variants for actual values.
 * Sensitive values are masked (****LAST4).
 */
async function collectEnvSnapshot(cwd: string): Promise<Record<string, string>> {
  try {
    const results = await parseEnv(cwd);
    const snapshot: Record<string, string> = {};
    for (const result of results) {
      for (const key of result.keys) {
        const raw = process.env[key.key] ?? '';
        snapshot[key.key] = raw ? maskEnvVariables({ [key.key]: raw })[key.key] : '';
      }
    }
    return snapshot;
  } catch {
    return {};
  }
}

/** Pretty-print a dependency diff with colour-highlighted lines. */
function printDiff(diff: DependencyDiff): void {
  if (!diff.added.length && !diff.updated.length && !diff.removed.length) {
    log.info(chalk.dim('No dependency changes detected.'));
    return;
  }
  if (diff.added.length) {
    log.info(chalk.green.bold('  Added:'));
    diff.added.forEach((n) => console.log(chalk.green(`    + ${n}`)));
  }
  if (diff.updated.length) {
    log.info(chalk.yellow.bold('  Updated:'));
    diff.updated.forEach(({ name, oldVersion, newVersion }) =>
      console.log(
        chalk.yellow(`    ~ ${name}: `) +
          chalk.dim(oldVersion) +
          chalk.yellow(' → ') +
          chalk.white(newVersion)
      )
    );
  }
  if (diff.removed.length) {
    log.info(chalk.red.bold('  Removed:'));
    diff.removed.forEach((n) => console.log(chalk.red(`    - ${n}`)));
  }
}

/** Build a short human-readable summary from a diff. */
function diffSummary(diff: DependencyDiff, devName: string): string {
  const parts: string[] = [];
  if (diff.updated.length)
    parts.push(diff.updated.map((u) => `${u.name} ${u.oldVersion}→${u.newVersion}`).join(', '));
  if (diff.added.length) parts.push(`added: ${diff.added.join(', ')}`);
  if (diff.removed.length) parts.push(`removed: ${diff.removed.join(', ')}`);
  return `[${devName}] ${parts.join(' | ')}`;
}

/**
 * Compare two semver strings; returns true if b > a.
 * Falls back to string comparison when semver cannot parse.
 */
function isNewer(a: string, b: string): boolean {
  const ca = semver.coerce(a)?.version;
  const cb = semver.coerce(b)?.version;
  if (ca && cb) return semver.gt(cb, ca);
  return b > a;
}

async function requireProject() {
  const config = await readLocalConfig();
  if (!config.projectId) {
    log.error('No project configured in this directory.');
    log.info('Run `dmx init <projectId>` to start tracking this project.');
    process.exit(1);
  }
  return config as typeof config & { projectId: string; devId: string };
}

// ─── dmx add dev <projectId> ─────────────────────────────────────────────────

/**
 * Registers the current machine as a developer on a project.
 * This is now the entry point for `dmx init`.
 */
export async function cmdAddDev(projectId: string): Promise<void> {
  const cwd = process.cwd();
  const s = spinner();
  s.start('Initializing DMX context in this directory…');

  try {
    const config = await readLocalConfig();
    const { devId } = config;
    const devName = config.name ?? os.userInfo().username;

    const [deps, env] = await Promise.all([scanLocalDeps(cwd), collectEnvSnapshot(cwd)]);

    // Check if already registered
    const existing = await getDeveloper(projectId, devId).catch(() => null);
    const isNew = !existing;

    // 1. Update cloud registration
    await upsertDeveloper(projectId, devId, { 
       name: devName, 
       dependencies: deps, 
       env, 
       user_id: config.userId 
    });

    // 2. Save project ID locally to the current directory
    await writeProjectConfig({ projectId });

    // 3. Push initial version snapshot if this is a fresh join
    if (isNew) {
      await pushVersionSnapshot(projectId, devId, {
        dependencies: deps,
        changes: { added: Object.keys(deps), updated: [], removed: [] },
        message: `Initial registration by ${devName}`,
        devName,
      });
    }

    s.stop(
      isNew
        ? chalk.green(`Joined project "${projectId}".`)
        : chalk.cyan(`Already in project "${projectId}" — profile updated.`)
    );

    log.info(
      `  ${chalk.bold('Developer ID:')} ${chalk.cyan(devId)}\n` +
        `  ${chalk.bold('Project ID:')}   ${chalk.cyan(projectId)}\n` +
        `  ${chalk.bold('Username:')}     ${chalk.cyan(devName)}\n` +
        `  ${chalk.bold('Deps captured:')} ${chalk.cyan(Object.keys(deps).length)}\n` +
        `  Project config saved to ${chalk.bold('./.dmxrc')}\n` +
        `  Identity saved to ${chalk.dim('~/.dmxrc')}`
    );
  } catch (err: any) {
    s.stop(chalk.red('Registration failed.'));
    log.error(err.message);
    process.exit(1);
  }
}

// ─── dmx update list ─────────────────────────────────────────────────────────

/**
 * Fetches the OFFICIAL project latest state from Supabase and reports
 * which packages you are out of sync with. Does NOT push anything.
 */
export async function cmdUpdateList(): Promise<void> {
  const s = spinner();
  s.start('Fetching official project state…');

  try {
    const config = await requireProject();
    const { projectId } = config;
    const cwd = process.cwd();

    const [localDeps, officialState] = await Promise.all([
      scanLocalDeps(cwd),
      getProjectLatestUpdate(projectId),
    ]);

    if (!officialState) {
      s.stop(chalk.yellow('No official project state exists yet.'));
      log.info(
        'No developer has promoted an official version yet.\n' +
          'Run `dmx logs push` to set the first official baseline.'
      );
      return;
    }

    const diff = getDependencyDiff(localDeps, officialState.dependencies);
    const hasChanges = diff.added.length || diff.updated.length || diff.removed.length;

    s.stop(
      hasChanges
        ? chalk.yellow(`You are out of sync with the official project state (last updated by ${chalk.bold(officialState.updatedByName)}).`)
        : chalk.green('You are up to date with the official project state. ✓')
    );

    if (hasChanges) {
      console.log('');
      console.log(
        chalk.dim(`  Official state last updated: ${
          officialState.lastUpdated
            ? new Date(officialState.lastUpdated as any).toLocaleString()
            : 'unknown'
        }`)
      );
      console.log('');
      log.info(chalk.bold('Changes in official state vs your local:'));
      printDiff(diff);
      console.log('');
      log.info(`Run ${chalk.cyan('dmx update')} to apply the official versions.`);
    }
  } catch (err: any) {
    s.stop(chalk.red('Failed to fetch project state.'));
    log.error(err.message);
    process.exit(1);
  }
}

// ─── dmx update (no args) ────────────────────────────────────────────────────

/**
 * Merges the OFFICIAL project latest dependencies into local package.json
 * and runs npm install.
 */
export async function cmdUpdateOfficial(): Promise<void> {
  const s = spinner();
  s.start('Fetching official project dependencies…');

  try {
    const config = await requireProject();
    const { projectId, devId } = config;
    const cwd = process.cwd();

    const officialState = await getProjectLatestUpdate(projectId);
    if (!officialState) {
      s.stop(chalk.yellow('No official state exists yet.'));
      log.info('Nothing to sync. Promote a version first with `dmx logs push`.');
      return;
    }

    s.stop(`Applying ${chalk.bold('official')} project dependencies…`);
    await applyDepsToPackageJson(cwd, officialState.dependencies, 'Official Project');

    // Update own Supabase doc to reflect the sync
    const newDeps = await scanLocalDeps(cwd);
    await upsertDeveloper(projectId, devId, {
      name: config.name ?? os.userInfo().username,
      dependencies: newDeps,
      env: await collectEnvSnapshot(cwd),
      synced_from: `Official (${officialState.updatedByName})`,
      user_id: config.userId,
    });

    log.success(chalk.green('Synced from official project state.'));
  } catch (err: any) {
    s.stop(chalk.red('Sync failed.'));
    log.error(err.message);
    process.exit(1);
  }
}

// ─── dmx update <devName> ────────────────────────────────────────────────────

/**
 * Fetches a specific team member's current versions and merges them locally.
 */
export async function cmdUpdateFrom(devName: string): Promise<void> {
  const s = spinner();
  s.start(`Fetching versions from ${chalk.cyan(devName)}…`);

  try {
    const config = await requireProject();
    const { projectId, devId } = config;
    const cwd = process.cwd();

    const dev = await getDeveloper(projectId, devName);
    if (!dev) {
      s.stop(chalk.red(`Developer "${devName}" not found in project.`));
      log.info('Check available developers with: dmx list devs');
      process.exit(1);
    }

    const sourceLabel = dev.data.name;
    s.stop(`Applying versions from ${chalk.cyan(sourceLabel)}…`);

    await applyDepsToPackageJson(cwd, dev.data.dependencies, sourceLabel);

    // Sync env keys (append missing, leave values blank)
    const remoteEnvKeys = Object.keys(dev.data.env ?? {});
    if (remoteEnvKeys.length > 0) {
      await syncEnvKeys(cwd, remoteEnvKeys, sourceLabel);
    }

    // Update own Supabase doc
    const newDeps = await scanLocalDeps(cwd);
    await upsertDeveloper(projectId, devId, {
      name: config.name ?? os.userInfo().username,
      dependencies: newDeps,
      env: await collectEnvSnapshot(cwd),
      synced_from: sourceLabel,
      user_id: config.userId,
    });

    log.success(chalk.green(`Synced from ${chalk.bold(sourceLabel)}.`));
  } catch (err: any) {
    s.stop(chalk.red('Sync failed.'));
    log.error(err.message);
    process.exit(1);
  }
}

// ─── dmx status ──────────────────────────────────────────────────────────────

/**
 * Renders a multi-column comparison:
 *   Package | Local | Official | Team Max
 * Highlights packages that differ from both official and team max.
 */
export async function cmdStatus(): Promise<void> {
  const s = spinner();
  s.start('Gathering project status…');

  try {
    const config = await requireProject();
    const { projectId } = config;
    const cwd = process.cwd();

    const [localDeps, officialState, allDevs] = await Promise.all([
      scanLocalDeps(cwd),
      getProjectLatestUpdate(projectId),
      getAllDevelopers(projectId),
    ]);

    s.stop('');

    const officialDeps = officialState?.dependencies ?? {};

    // Build "Team Max" — highest version of each package across all team members
    const teamMax: DependencyMap = {};
    for (const { data } of allDevs) {
      for (const [pkg, ver] of Object.entries(data.dependencies ?? {})) {
        if (!teamMax[pkg] || isNewer(teamMax[pkg], ver as string)) {
          teamMax[pkg] = ver as string;
        }
      }
    }

    // Collect all known packages (union across all sources)
    const allPkgs = new Set([
      ...Object.keys(localDeps),
      ...Object.keys(officialDeps),
      ...Object.keys(teamMax),
    ]);

    // Column widths
    const COL_PKG = 32;
    const COL_VER = 18;

    const header =
      chalk.bold.white('Package'.padEnd(COL_PKG)) +
      chalk.bold.cyan('Local'.padEnd(COL_VER)) +
      chalk.bold.blue('Official'.padEnd(COL_VER)) +
      chalk.bold.magenta('Team Max'.padEnd(COL_VER));

    const divider = chalk.dim('─'.repeat(COL_PKG + COL_VER * 3));

    console.log('');
    console.log(chalk.bold.white(`  Project: ${config.projectId}`));
    console.log(
      chalk.dim(
        `  Official by: ${officialState?.updatedByName ?? 'N/A'}  |  Team: ${allDevs.length} dev(s)`
      )
    );
    console.log('');
    console.log('  ' + header);
    console.log('  ' + divider);

    let outOfSync = 0;

    for (const pkg of [...allPkgs].sort()) {
      const local = localDeps[pkg] ?? chalk.dim('—');
      const official = officialDeps[pkg] ?? chalk.dim('—');
      const team = teamMax[pkg] ?? chalk.dim('—');

      const localStr = localDeps[pkg] ?? '—';
      const officialStr = officialDeps[pkg] ?? '—';
      const teamStr = teamMax[pkg] ?? '—';

      // Highlight logic
      const localColored =
        localStr === officialStr
          ? chalk.green(localStr.padEnd(COL_VER))
          : localStr === '—'
          ? chalk.dim('—'.padEnd(COL_VER))
          : chalk.red(localStr.padEnd(COL_VER));

      const officialColored = chalk.blue((officialStr).padEnd(COL_VER));

      const teamColored =
        teamStr !== officialStr && teamStr !== '—'
          ? chalk.yellow(teamStr.padEnd(COL_VER))
          : chalk.magenta((teamStr).padEnd(COL_VER));

      if (localStr !== officialStr && localStr !== '—' && officialStr !== '—') outOfSync++;

      console.log(
        '  ' +
          pkg.padEnd(COL_PKG).slice(0, COL_PKG) +
          localColored +
          officialColored +
          teamColored
      );
    }

    console.log('  ' + divider);
    console.log('');
    if (outOfSync > 0) {
      log.warn(
        `${chalk.red(outOfSync)} package(s) differ from the official state. ` +
          `Run ${chalk.cyan('dmx update')} to align.`
      );
    } else {
      log.success('You are fully aligned with the official project state. ✓');
    }
    console.log('');
  } catch (err: any) {
    log.error(err.message);
    process.exit(1);
  }
}

// ─── dmx logs push ───────────────────────────────────────────────────────────

/**
 * Captures the current dependency snapshot, computes what changed since
 * the last recorded snapshot, and stores the diff + full map to the
 * developer's version timeline in Supabase.
 *
 * This is a VERSION CHANGE TIMELINE — not a text/scan log.
 * After pushing, it also promotes the state as the new Official Project Latest.
 */
export async function cmdLogsPush(): Promise<void> {
  const s = spinner();
  s.start('Capturing version snapshot…');

  try {
    const config = await requireProject();
    const { projectId, devId } = config;
    const devName = config.name ?? os.userInfo().username;
    const cwd = process.cwd();

    const [currentDeps, env] = await Promise.all([scanLocalDeps(cwd), collectEnvSnapshot(cwd)]);

    // Get last known state for this developer from Supabase to compute diff
    const storedDev = await getDeveloper(projectId, devId).catch(() => null);
    const previousDeps: DependencyMap = storedDev?.data.dependencies ?? {};

    const diff = getDependencyDiff(previousDeps, currentDeps);
    const hasChanges = diff.added.length || diff.updated.length || diff.removed.length;

    const message = hasChanges
      ? diffSummary(diff, devName)
      : `[${devName}] No version changes`;

    if (!hasChanges) {
      // 2. Update developer doc (Heartbeat/Presence)
      await upsertDeveloper(projectId, devId, { name: devName, dependencies: currentDeps, env, user_id: config.userId });
      s.stop(chalk.dim('No version changes detected. Local environment is aligned.'));
      return;
    }

    // 1. Push version timeline snapshot
    await pushVersionSnapshot(projectId, devId, {
      dependencies: currentDeps,
      changes: diff,
      message,
      devName,
    });

    // 2. Update developer doc
    await upsertDeveloper(projectId, devId, { name: devName, dependencies: currentDeps, env, user_id: config.userId });

    // 3. Promote as new Official Project Latest
    await updateProjectState(projectId, {
      dependencies: currentDeps,
      updatedBy: devId,
      updatedByName: devName,
    });

    // 4. Notify team if there were actual changes
    await createNotification(projectId, {
      message,
      changes: diff,
      triggeredBy: devId,
    });

    s.stop(chalk.green('Version snapshot pushed.'));

    console.log('');
    log.info(chalk.bold('Changes recorded in this snapshot:'));
    printDiff(diff);

    log.success(
      `Timeline updated in Supabase. ${chalk.dim(`Project: ${projectId}`)}`
    );
  } catch (err: any) {
    log.error(err.message);
    process.exit(1);
  }
}

// ─── dmx list devs ───────────────────────────────────────────────────────────

export async function cmdListDevs(): Promise<void> {
  const s = spinner();
  s.start('Fetching developers…');

  try {
    const config = await requireProject();
    const devs = await getAllDevelopers(config.projectId);

    s.stop(
      `Found ${chalk.cyan(devs.length)} developer(s) in project ${chalk.bold(config.projectId)}.\n`
    );

    if (!devs.length) {
      log.info('No developers registered yet.');
      return;
    }

    for (const { id, data } of devs) {
      const isMe = id === config.devId;
      const depCount = Object.keys(data.dependencies ?? {}).length;
      const lastActive = data.last_active
        ? new Date(data.last_active).toLocaleString()
        : 'unknown';

      console.log(
        `  ${chalk.cyan.bold(data.name)}${isMe ? chalk.green(' (you)') : ''}  ` +
          chalk.dim(`id: ${id}`) +
          `\n    ${chalk.white(depCount)} deps  |  last active: ${chalk.dim(lastActive)}`
      );
    }
    console.log('');
  } catch (err: any) {
    log.error(err.message);
    process.exit(1);
  }
}

// ─── Internal: apply remote deps to package.json ─────────────────────────────

async function applyDepsToPackageJson(
  cwd: string,
  remoteDeps: DependencyMap,
  sourceLabel: string
): Promise<void> {
  const pkgPath = path.join(cwd, 'package.json');
  let pkg: any;
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  } catch {
    log.error('Cannot read package.json in the current directory.');
    process.exit(1);
  }

  // Only diff/apply npm-level keys — strip runtime:, pip:, env:, tool: prefixes
  const remoteNpmDeps = extractNpmDeps(remoteDeps);
  const localDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const diff = getDependencyDiff(localDeps, remoteNpmDeps);
  const hasNodeChanges = diff.added.length || diff.updated.length || diff.removed.length;

  if (!hasNodeChanges) {
    log.info(chalk.dim(`Already in sync with ${sourceLabel}. No changes applied.`));
    return;
  }

  printDiff(diff);

  // Apply changes to correct section (dep or devDep)
  for (const name of diff.added) {
    if (remoteNpmDeps[name]) {
      pkg.dependencies = pkg.dependencies ?? {};
      pkg.dependencies[name] = remoteNpmDeps[name];
    }
  }
  for (const { name, newVersion } of diff.updated) {
    if (pkg.dependencies?.[name]) pkg.dependencies[name] = newVersion;
    else if (pkg.devDependencies?.[name]) pkg.devDependencies[name] = newVersion;
  }
  for (const name of diff.removed) {
    delete pkg.dependencies?.[name];
    delete pkg.devDependencies?.[name];
  }

  await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  log.info(chalk.cyan('package.json updated. Running npm install…'));

  const s = spinner();
  s.start('npm install');
  try {
    await execa('npm', ['install'], { cwd, stdio: 'pipe' });
    s.stop(chalk.green('npm install complete.'));
  } catch (err: any) {
    s.stop(chalk.red('npm install failed.'));
    log.warn(err.message);
  }
}

async function syncEnvKeys(
  cwd: string,
  remoteKeys: string[],
  sourceLabel: string
): Promise<void> {
  try {
    const envPath = path.join(cwd, '.env');
    // Use EnvParser to discover what keys are already present locally
    const localResults = await parseEnv(cwd).catch(() => []);
    const localKeys = localResults.flatMap(r => r.keys.map(k => k.key));
    const missing = remoteKeys.filter((k) => !localKeys.includes(k));
    if (!missing.length) return;
    const lines = missing.map((k) => `${k}=`).join('\n');
    await fs.appendFile(envPath, `\n# Keys synced from ${sourceLabel}\n${lines}\n`);
    log.warn(
      chalk.yellow(
        `Appended ${missing.length} missing env key(s) to .env (fill in values): `
      ) + chalk.dim(missing.join(', '))
    );
  } catch {}
}

// ─── dmx link ────────────────────────────────────────────────────────────────

/**
 * Links this CLI to a DMX web account.
 *
 * The webToken is the user's Supabase user.id shown on the Developer Dashboard.
 * After linking, all future cloud sync operations (dmx add dev, dmx logs push)
 * will include this user_id, so the dashboard can identify which CLI
 * instance belongs to which web account.
 *
 * Usage: dmx link <webToken>
 */
export async function cmdLink(webToken: string): Promise<void> {
  if (!webToken || webToken.trim().length === 0) {
    log.error('Usage: dmx link <webToken>');
    log.info('Find your token on your Developer Dashboard under "Link your CLI".');
    process.exit(1);
  }

  try {
    const config = await readLocalConfig();
    await writeLocalConfig({ ...config, userId: webToken.trim() });

    log.success(
      chalk.green('CLI linked to your web account. ✓') + '\n' +
      chalk.dim(`  Token stored in ~/.dmxrc`) + '\n' +
      chalk.dim(`  Future syncs will associate this machine with your dashboard profile.`)
    );
  } catch (err: any) {
    log.error(`Failed to link: ${err.message}`);
    process.exit(1);
  }
}

// ─── dmx remove ──────────────────────────────────────────────────────────────

/**
 * Removes the current project tracking from the local machine.
 * Clears projectId from ~/.dmxrc.
 */
export async function cmdRemoveProject(): Promise<void> {
  try {
    const config = await readLocalConfig();
    if (!config.projectId) {
      log.info('No project is currently being tracked.');
      return;
    }

    const oldId = config.projectId;
    const { devId } = config;

    // 1. Remove from cloud
    const s = spinner();
    s.start('Removing registration from cloud…');
    await deleteDeveloper(oldId, devId).catch(() => {
      // If network fails or project doesn't exist anymore, we proceed with local clear
    });
    s.stop(chalk.dim('Cloud registration removed.'));

    // 2. Delete local config file
    await deleteProjectConfig();

    log.success(
      chalk.green('Project tracking removed. ✓') + '\n' +
      chalk.dim(`  The local .dmxrc has been removed. Identity preserved in ~/.dmxrc.`)
    );
  } catch (err: any) {
    log.error(`Failed to remove project: ${err.message}`);
    process.exit(1);
  }
}

