import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  matchesAgentDatabaseReadCandidatePath,
  type AgentDatabaseReadCandidate,
} from "../../infra/agent-database-readers.js";
import { readSqliteDatabaseScopedWriteTokenForPath } from "../../infra/sqlite-database-admission.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import type { AuthProfileRowRead } from "./types.js";

type RowsReader = {
  identity?: string;
  read: () => Promise<AuthProfileRowRead>;
  assertCurrent: () => void;
};

/** A derived rows cache; the runtime snapshot owner supplies publication generations. */
export function createRuntimeAuthProfileRowsCache(revisionAtPath: (path: string) => string) {
  type Refresh = () => Promise<AuthProfileRowRead>;
  type Entry = {
    identity: string | undefined;
    writeToken: string;
    revision: string;
    rows: AuthProfileRowRead;
    refresh?: Refresh;
  };
  const entries = new Map<string, Entry>();
  const refreshing = new Map<string, { pending: boolean; result: Promise<string[]> }>();
  const hasCurrentSource = (databasePath: string, entry: Entry) =>
    revisionAtPath(databasePath) === entry.revision &&
    readSqliteDatabaseScopedWriteTokenForPath(databasePath, "auth-profiles") === entry.writeToken;
  const isCurrent = (databasePath: string, entry: Entry) =>
    entries.get(databasePath) === entry && hasCurrentSource(databasePath, entry);
  return {
    clear(databasePath?: string) {
      if (databasePath === undefined) {
        entries.clear();
      } else {
        entries.delete(databasePath);
      }
    },
    retire(candidates: readonly AgentDatabaseReadCandidate[], retainedPaths?: ReadonlySet<string>) {
      for (const databasePath of entries.keys()) {
        if (
          !retainedPaths?.has(databasePath) &&
          candidates.some((candidate) =>
            matchesAgentDatabaseReadCandidatePath(candidate, databasePath),
          )
        ) {
          entries.delete(databasePath);
        }
      }
    },
    publishSnapshots(databasePaths: ReadonlySet<string>) {
      for (const [databasePath, entry] of entries) {
        if (!databasePaths.has(databasePath)) {
          entries.delete(databasePath);
        } else if (
          readSqliteDatabaseScopedWriteTokenForPath(databasePath, "auth-profiles") ===
          entry.writeToken
        ) {
          entry.revision = revisionAtPath(databasePath);
        }
      }
    },
    refreshChanged(directory: string, requiredPaths: readonly string[] = []): Promise<string[]> {
      const key = path.resolve(directory);
      const required = new Map(
        requiredPaths
          .filter((databasePath) => path.dirname(path.resolve(databasePath)) === key)
          .map((databasePath) => [databasePath, revisionAtPath(databasePath)]),
      );
      const active = refreshing.get(key);
      if (active) {
        active.pending = true;
        return active.result;
      }
      const operation = { pending: true, result: Promise.resolve<string[]>([]) };
      operation.result = Promise.resolve().then(async () => {
        const changed = new Map<string, Entry>();
        try {
          while (operation.pending) {
            operation.pending = false;
            for (const [databasePath, entry] of [...entries]) {
              if (path.dirname(path.resolve(databasePath)) !== key || !entry.refresh) {
                continue;
              }
              if (!isCurrent(databasePath, entry)) {
                continue;
              }
              let rows: AuthProfileRowRead | undefined;
              try {
                rows = await entry.refresh();
              } catch {
                // A failed external reread cannot certify the cached credential facts.
              }
              if (!isCurrent(databasePath, entry)) {
                continue;
              }
              if (!rows?.cacheable || !isDeepStrictEqual(rows, entry.rows)) {
                entries.delete(databasePath);
                changed.set(databasePath, entry);
              }
            }
          }
          const result = [...changed].flatMap(([databasePath, entry]) =>
            !entries.has(databasePath) && hasCurrentSource(databasePath, entry)
              ? [databasePath]
              : [],
          );
          for (const [databasePath, revision] of required) {
            const entry = entries.get(databasePath);
            if (
              revisionAtPath(databasePath) === revision &&
              (!entry?.refresh || !isCurrent(databasePath, entry))
            ) {
              result.push(databasePath);
            }
          }
          return [...new Set(result)];
        } finally {
          refreshing.delete(key);
        }
      });
      refreshing.set(key, operation);
      return operation.result;
    },
    prepare(databasePath: string, reader: RowsReader, refresh?: Refresh, reuse = true): RowsReader {
      const revision = revisionAtPath(databasePath);
      return {
        assertCurrent: reader.assertCurrent,
        async read() {
          reader.assertCurrent();
          const entry = entries.get(databasePath);
          // Session-only writes leave auth rows intact; auth and unscoped writes still fence reuse.
          const writeToken = readSqliteDatabaseScopedWriteTokenForPath(
            databasePath,
            "auth-profiles",
          );
          if (
            reuse &&
            writeToken !== undefined &&
            entry?.identity === reader.identity &&
            entry?.revision === revision &&
            entry.writeToken === writeToken
          ) {
            entry.refresh = refresh ?? entry.refresh;
            return entry.rows;
          }
          entries.delete(databasePath);
          // Only completed, certified reads can serve another caller's later snapshot.
          const rows = await reader.read();
          reader.assertCurrent();
          if (
            rows.cacheable &&
            rows.store.status !== "unreadable" &&
            rows.state.status !== "unreadable" &&
            revisionAtPath(databasePath) === revision &&
            writeToken !== undefined &&
            readSqliteDatabaseScopedWriteTokenForPath(databasePath, "auth-profiles") === writeToken
          ) {
            freezeJsonSnapshot(rows);
            entries.set(databasePath, {
              identity: reader.identity,
              writeToken,
              revision,
              rows,
              refresh,
            });
          }
          return rows;
        },
      };
    },
  };
}
