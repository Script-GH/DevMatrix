import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const GLOBAL_CONFIG_PATH = path.join(os.homedir(), '.dmxrc');
const LOCAL_CONFIG_PATH = path.join(process.cwd(), '.dmxrc');

export interface GlobalConfig {
  devId: string;
  name?: string;
  userId?: string;
}

export interface ProjectConfig {
  projectId: string;
}

export type EffectiveConfig = GlobalConfig & Partial<ProjectConfig>;
export type LocalConfig = EffectiveConfig; // Compatibility alias

/**
 * Reads the global DMX identity from ~/.dmxrc.
 * Auto-generates devId if missing.
 */
async function readGlobalConfig(): Promise<GlobalConfig> {
  try {
    const content = await fs.readFile(GLOBAL_CONFIG_PATH, 'utf8');
    const config = JSON.parse(content);
    if (!config.devId) throw new Error('Missing devId');
    return config;
  } catch {
    const fresh: GlobalConfig = {
      devId: crypto.randomUUID(),
      name: os.userInfo().username,
    };
    await writeGlobalConfig(fresh);
    return fresh;
  }
}

/**
 * Writes to the global identity file.
 */
export async function writeGlobalConfig(config: GlobalConfig): Promise<void> {
  await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Reads the local project config from ./.dmxrc.
 */
async function readProjectConfig(): Promise<ProjectConfig | null> {
  try {
    const content = await fs.readFile(LOCAL_CONFIG_PATH, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Writes the project ID to the local .dmxrc.
 */
export async function writeProjectConfig(config: ProjectConfig): Promise<void> {
  await fs.writeFile(LOCAL_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Returns the effective configuration (Global ID + Local Project).
 */
export async function readLocalConfig(): Promise<EffectiveConfig> {
  const global = await readGlobalConfig();
  const project = await readProjectConfig();
  return { ...global, ...project };
}

/**
 * Compatibility helper for existing code that expects a full write.
 * In the new system, this only updates Global properties unless specified.
 */
export async function writeLocalConfig(config: EffectiveConfig): Promise<void> {
  const { projectId, ...global } = config;
  await writeGlobalConfig(global);
  if (projectId) {
    await writeProjectConfig({ projectId });
  }
}

/**
 * Deletes the local project config file.
 */
export async function deleteProjectConfig(): Promise<void> {
  await fs.unlink(LOCAL_CONFIG_PATH).catch(() => {});
}
