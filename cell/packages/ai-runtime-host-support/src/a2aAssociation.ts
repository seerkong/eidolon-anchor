import { Database } from "bun:sqlite";
import { mkdirSync, openSync, closeSync, constants } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { HostParticipantSendCommand } from "@cell/ai-runtime-host-contract";

export type ParticipantTaskAssociation = Readonly<{
  taskId: string;
  contextId: string;
  principalId: string;
  command: HostParticipantSendCommand;
  admissionRejection?: string;
}>;
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
/** Protocol identity association only; canonical task status is never saved here. */
export function createA2AAssociations(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = join(directory, "a2a-associations.sqlite");
  closeSync(
    openSync(
      filename,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    ),
  );
  const db = new Database(filename, { strict: true });
  db.exec(`PRAGMA busy_timeout=2000;
    CREATE TABLE IF NOT EXISTS a2a_contexts(principal TEXT NOT NULL,binding TEXT NOT NULL,context TEXT NOT NULL UNIQUE,PRIMARY KEY(principal,binding));
    CREATE TABLE IF NOT EXISTS a2a_associations(principal TEXT NOT NULL,binding TEXT NOT NULL,request TEXT NOT NULL,task TEXT NOT NULL UNIQUE,value TEXT NOT NULL,PRIMARY KEY(principal,binding,request));`);
  const receipt = (
    principal: string,
    binding: string,
    request: string,
  ): ParticipantTaskAssociation | undefined => {
    const row = db
      .query<
        { value: string },
        [string, string, string]
      >("SELECT value FROM a2a_associations WHERE principal=? AND binding=? AND request=?")
      .get(principal, binding, request);
    return row ? JSON.parse(row.value) : undefined;
  };
  const context = db.transaction((principal: string, binding: string) => {
    const old = db
      .query<
        { context: string },
        [string, string]
      >("SELECT context FROM a2a_contexts WHERE principal=? AND binding=?")
      .get(principal, binding);
    if (old) return old.context;
    const id = randomUUID();
    db.query("INSERT INTO a2a_contexts VALUES(?,?,?)").run(
      principal,
      binding,
      id,
    );
    return id;
  }).immediate;
  return {
    context,
    receipt,
    task(principal: string, id: string) {
      const row = db
        .query<
          { value: string },
          [string, string]
        >("SELECT value FROM a2a_associations WHERE principal=? AND task=?")
        .get(principal, id);
      return row
        ? (JSON.parse(row.value) as ParticipantTaskAssociation)
        : undefined;
    },
    accept: db.transaction(
      (principalId: string, command: HostParticipantSendCommand): ParticipantTaskAssociation => {
        const old = receipt(principalId, command.bindingKey, command.commandId);
        if (old) {
          if (canonical(old.command) !== canonical(command))
            throw new Error("idempotency_conflict");
          return old;
        }
        const size = db
          .query<
            { count: number },
            []
          >("SELECT count(*) AS count FROM a2a_associations")
          .get()!.count;
        if (size >= 8192) throw new Error("a2a_association_capacity");
        const value = {
          taskId: randomUUID(),
          contextId: context(principalId, command.bindingKey),
          principalId,
          command: structuredClone(command),
        };
        db.query("INSERT INTO a2a_associations VALUES(?,?,?,?,?)").run(
          principalId,
          command.bindingKey,
          command.commandId,
          value.taskId,
          JSON.stringify(value),
        );
        return value;
      },
    ).immediate,
    rejectAdmission(row: ParticipantTaskAssociation, code: string) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,95}$/.test(code))
        throw new Error("invalid_admission_rejection");
      const old = receipt(
        row.principalId,
        row.command.bindingKey,
        row.command.commandId,
      );
      if (
        !old ||
        old.taskId !== row.taskId ||
        (old.admissionRejection && old.admissionRejection !== code)
      )
        throw new Error("admission_rejection_conflict");
      const value = { ...old, admissionRejection: code };
      db.query(
        "UPDATE a2a_associations SET value=? WHERE principal=? AND task=?",
      ).run(JSON.stringify(value), row.principalId, row.taskId);
      return value;
    },
    list(principal: string, contextId: string, limit: number) {
      return db
        .query<{ value: string }, [string, string, string, number]>(
          "SELECT value FROM a2a_associations WHERE principal=? AND (?='' OR json_extract(value,'$.contextId')=?) ORDER BY rowid DESC LIMIT ?",
        )
        .all(principal, contextId, contextId, limit)
        .map((r) => JSON.parse(r.value) as ParticipantTaskAssociation);
    },
    close() {
      db.close();
    },
  };
}
