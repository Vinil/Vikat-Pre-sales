/**
 * npm run session:list
 * npm run session:delete -- <session-id> [<session-id> ...]
 * npm run session:delete -- --all
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.ts';

const ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

export function listSessions(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && ID.test(e.name))
    .map((e) => e.name)
    .sort();
}

export function deleteSessions(dir: string, ids: string[]): string[] {
  const deleted: string[] = [];
  for (const id of ids) {
    // Only ever remove directories that look like sessions, inside sessions/.
    if (!ID.test(id)) throw new Error(`Not a session id: ${id}`);
    const target = path.join(dir, id);
    if (!fs.existsSync(target)) throw new Error(`No such session: ${id}`);
    fs.rmSync(target, { recursive: true, force: true });
    deleted.push(id);
  }
  return deleted;
}

if (process.argv[1]?.endsWith('sessions.ts')) {
  const { sessionsDir } = loadConfig();
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (cmd === 'list') {
      const ids = listSessions(sessionsDir);
      console.log(ids.length ? ids.join('\n') : 'No sessions.');
    } else if (cmd === 'delete') {
      const ids = args.includes('--all') ? listSessions(sessionsDir) : args;
      if (ids.length === 0) throw new Error('Name a session id, or pass --all.');
      for (const id of deleteSessions(sessionsDir, ids)) console.log(`Deleted ${id}`);
    } else {
      throw new Error('Usage: sessions.ts list | delete <id...> | delete --all');
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
