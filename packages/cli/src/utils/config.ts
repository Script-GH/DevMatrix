import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const CONFIG_PATH = path.join(os.homedir(), '.dmxrc');

export interface LocalConfig {
  devId: string;
  projectId?: string;
  name?: string;
  /** Web account token set by `dmx link <webToken>`. Used to associate this CLI with a dashboard user. */
  userId?: string;
}

/**
 * Reads the local DMX config from ~/.dmxrc.
 * If file is missing or corrupt, creates a fresh one with a new devId.
 */
export async function readLocalConfig(): Promise<LocalConfig> {
  try {
    const content = await fs.readFile(CONFIG_PATH, 'utf8');
    let config: Partial<LocalConfig>;

    try {
      config = JSON.parse(content);
    } catch {
      throw new Error('Config file is corrupt');
    }

    // Ensure devId is always present and valid
    if (!config.devId || typeof config.devId !== 'string') {
      config.devId = crypto.randomUUID();
      await writeLocalConfig(config as LocalConfig);
    }

    return config as LocalConfig;
  } catch (err: any) {
    // First-time user or corrupt config — create fresh
    const freshConfig: LocalConfig = {
      devId: crypto.randomUUID(),
      name: os.userInfo().username,
    };
    await writeLocalConfig(freshConfig);
    return freshConfig;
  }
}

/**
 * Writes config to ~/.dmxrc atomically.
 */
export async function writeLocalConfig(config: LocalConfig): Promise<void> {
  const tmp = `${CONFIG_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2), 'utf8');
  await fs.rename(tmp, CONFIG_PATH);
}
