import { Database } from 'bun:sqlite';
import { constants, openSync, closeSync, fstatSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { DaemonScheduleState, DaemonScheduleStore } from '@cell/ai-runtime-host-contract';
import { parseDaemonScheduleView, parseDaemonScheduleReceipt } from '@cell/ai-runtime-host-contract';
/** Parent writer lease owns this store; an expected revision also guards accidental duplicate owners. */
export function openDaemonScheduleStore(directory: string): DaemonScheduleStore {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid())
        throw new Error('unsafe_schedule_directory');
    const filename = join(directory, 'schedules.sqlite'), fd = openSync(filename, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
        const f = fstatSync(fd);
        if (!f.isFile() || (f.mode & 0o077) !== 0 || process.getuid && f.uid !== process.getuid())
            throw new Error('unsafe_schedule_store');
    }
    finally {
        closeSync(fd);
    }
    const db = new Database(filename, { strict: true });
    db.exec('PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS schedule_state (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,body TEXT NOT NULL)');
    const initial: DaemonScheduleState = { version: 1, revision: 0, schedules: [], attempts: [], receipts: [] };
    db.query('INSERT OR IGNORE INTO schedule_state VALUES(1,0,?)').run(JSON.stringify(initial));
    return { read() {
            const raw = db.query<{
                body: string;
            }, [
            ]>('SELECT body FROM schedule_state WHERE id=1').get()!.body;
            const s = JSON.parse(raw) as DaemonScheduleState;
            if (s.version !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 0 || !Array.isArray(s.schedules) || s.schedules.length > 128 || !Array.isArray(s.attempts) || s.attempts.length > 12800 || !Array.isArray(s.receipts) || s.receipts.length > 4096 || new Set(s.schedules.map(p => p.scheduleId)).size !== s.schedules.length || new Set(s.attempts.map(a => a.attemptId)).size !== s.attempts.length)
                throw new Error('invalid_schedule_store');
            for (const plan of s.schedules) {
                if (plan.everyMinutes < 1 || plan.revision < 1)
                    throw new Error('invalid_schedule_store');
                const attempts = s.attempts.filter(a => a.scheduleId === plan.scheduleId);
                if (attempts.length > 100)
                    throw new Error('invalid_schedule_store');
                parseDaemonScheduleView({ revision: s.revision, schedules: [plan], attempts });
            }
            if (s.attempts.some(a => !s.schedules.some(p => p.scheduleId === a.scheduleId)))
                throw new Error('invalid_schedule_store');
            for (const r of s.receipts)
                parseDaemonScheduleReceipt(r);
            return s;
        },
        commit: db.transaction((expected: number, state: DaemonScheduleState) => { const body = JSON.stringify(state); if (Buffer.byteLength(body) > 256 * 1024 * 1024)
            throw new Error('schedule_store_capacity'); if (state.revision !== expected + 1)
            throw new Error('invalid_schedule_store_revision'); const changed = db.query('UPDATE schedule_state SET revision=?,body=? WHERE id=1 AND revision=?').run(state.revision, body, expected); if (changed.changes !== 1)
            throw new Error('schedule_store_conflict'); }),
        close: () => db.close() };
}
