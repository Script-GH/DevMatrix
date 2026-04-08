/**
 * Supabase service layer for DMX CLI.
 *
 * Replaces firebase.ts with identical export signatures so commands.ts
 * requires only an import path change, no logic changes.
 *
 * Tables expected (run the SQL init script in Supabase SQL Editor):
 *   projects, developers, project_latest_state, version_history, notifications
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { DependencyMap } from '../scanner/StackDetector.js';
import type { DependencyDiff } from '../engine/DiffEngine.js';

// ─── Client Initialization ────────────────────────────────────────────────────

function getConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      'Missing Supabase credentials.\n' +
        'Add SUPABASE_URL and SUPABASE_ANON_KEY to ~/.devpulse/.env'
    );
  }
  return { url, key };
}

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!_client) {
    const { url, key } = getConfig();
    _client = createClient(url, key);
  }
  return _client;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DeveloperDocument {
  name: string;
  dependencies: DependencyMap;
  env: Record<string, string>;
  last_active?: string;
  last_updated?: string;
  synced_from?: string;
  user_id?: string;
}

export interface VersionSnapshot {
  dependencies: DependencyMap;
  changes: DependencyDiff;
  message: string;
  timestamp?: string;
  devName: string;
}

export interface ProjectState {
  dependencies: DependencyMap;
  updatedBy: string;
  updatedByName: string;
  lastUpdated?: string;
}

// ─── Developer CRUD ───────────────────────────────────────────────────────────

/**
 * Upserts a developer row.
 * Also ensures the parent project row exists.
 */
export async function upsertDeveloper(
  projectId: string,
  devId: string,
  data: Partial<DeveloperDocument>
): Promise<void> {
  const sb = getClient();

  // Ensure project exists without overwriting name
  const { data: existingProj } = await sb.from('projects').select('id').eq('id', projectId).maybeSingle();
  if (!existingProj) {
    await sb.from('projects').insert({ id: projectId, name: projectId });
  }

  const { error } = await sb.from('developers').upsert(
    {
      id: devId,
      project_id: projectId,
      name: data.name,
      dependencies: data.dependencies ?? {},
      env_keys: data.env ?? {},
      last_active: new Date().toISOString(),
      synced_from: data.synced_from ?? null,
      user_id: data.user_id ?? null,
    },
    { onConflict: 'id' }
  );

  if (error) throw new Error(`upsertDeveloper: ${error.message}`);
}

/**
 * Fetch a developer by devId (fast path) or by name (scan fallback).
 */
export async function getDeveloper(
  projectId: string,
  devIdOrName: string
): Promise<{ id: string; data: DeveloperDocument } | null> {
  const sb = getClient();

  // Fast path — direct lookup by devId
  const { data: byId } = await sb
    .from('developers')
    .select('*')
    .eq('id', devIdOrName)
    .eq('project_id', projectId)
    .maybeSingle();

  if (byId) return { id: byId.id, data: rowToDeveloper(byId) };

  // Slow path — lookup by name
  const { data: byName } = await sb
    .from('developers')
    .select('*')
    .eq('project_id', projectId)
    .eq('name', devIdOrName)
    .maybeSingle();

  if (byName) return { id: byName.id, data: rowToDeveloper(byName) };

  return null;
}

/**
 * Returns all registered developers for a project.
 */
export async function getAllDevelopers(
  projectId: string
): Promise<{ id: string; data: DeveloperDocument }[]> {
  const sb = getClient();
  const { data, error } = await sb
    .from('developers')
    .select('*')
    .eq('project_id', projectId);

  if (error) throw new Error(`getAllDevelopers: ${error.message}`);
  return (data ?? []).map((row) => ({ id: row.id, data: rowToDeveloper(row) }));
}

function rowToDeveloper(row: any): DeveloperDocument {
  return {
    name: row.name,
    dependencies: row.dependencies ?? {},
    env: row.env_keys ?? {},
    last_active: row.last_active,
    last_updated: row.last_active,
    synced_from: row.synced_from,
  };
}

// ─── Official Project State ───────────────────────────────────────────────────

/**
 * Reads the canonical project_latest_state row.
 */
export async function getProjectLatestUpdate(
  projectId: string
): Promise<ProjectState | null> {
  const sb = getClient();
  const { data } = await sb
    .from('project_latest_state')
    .select('*')
    .eq('project_id', projectId)
    .maybeSingle();

  if (!data) return null;
  return {
    dependencies: data.dependencies ?? {},
    updatedBy: data.updated_by ?? '',
    updatedByName: data.updated_by_name ?? '',
    lastUpdated: data.updated_at,
  };
}

/**
 * Upserts the canonical project_latest_state row.
 */
export async function updateProjectState(
  projectId: string,
  data: Omit<ProjectState, 'lastUpdated'>
): Promise<void> {
  const sb = getClient();
  const { error } = await sb.from('project_latest_state').upsert(
    {
      project_id: projectId,
      dependencies: data.dependencies,
      updated_by: data.updatedBy,
      updated_by_name: data.updatedByName,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'project_id' }
  );
  if (error) throw new Error(`updateProjectState: ${error.message}`);
}

// ─── Version Snapshot Logging ─────────────────────────────────────────────────

/**
 * Inserts a new version-change snapshot into version_history.
 * This is the VERSION CHANGE TIMELINE — not a text log.
 */
export async function pushVersionSnapshot(
  projectId: string,
  devId: string,
  snapshot: Omit<VersionSnapshot, 'timestamp'>
): Promise<void> {
  const sb = getClient();
  const { error } = await sb.from('version_history').insert({
    project_id: projectId,
    dev_id: devId,
    dev_name: snapshot.devName,
    message: snapshot.message,
    changes: snapshot.changes,
    full_deps: snapshot.dependencies,
    created_at: new Date().toISOString(),
  });
  if (error) throw new Error(`pushVersionSnapshot: ${error.message}`);
}

/**
 * Retrieves the N most recent version snapshots for a developer.
 */
export async function getVersionHistory(
  projectId: string,
  devId: string,
  maxEntries = 10
): Promise<VersionSnapshot[]> {
  const sb = getClient();
  const { data, error } = await sb
    .from('version_history')
    .select('*')
    .eq('project_id', projectId)
    .eq('dev_id', devId)
    .order('created_at', { ascending: false })
    .limit(maxEntries);

  if (error) throw new Error(`getVersionHistory: ${error.message}`);
  return (data ?? []).map((row) => ({
    dependencies: row.full_deps ?? {},
    changes: row.changes ?? { added: [], updated: [], removed: [] },
    message: row.message,
    timestamp: row.created_at,
    devName: row.dev_name,
  }));
}

// ─── Notifications ────────────────────────────────────────────────────────────

/**
 * Inserts a team-wide notification into the notifications table.
 */
export async function createNotification(
  projectId: string,
  payload: { message: string; changes: DependencyDiff; triggeredBy: string }
): Promise<void> {
  const sb = getClient();
  const { error } = await sb.from('notifications').insert({
    project_id: projectId,
    message: payload.message,
    changes: payload.changes,
    triggered_by: payload.triggeredBy,
    created_at: new Date().toISOString(),
  });
  if (error) throw new Error(`createNotification: ${error.message}`);
}
