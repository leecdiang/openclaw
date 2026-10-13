import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "../../infra/node-sqlite.js";
import type { AdmissionOperations } from "../../infra/sqlite-database-admission.worker.test-support.js";
import { admitSqliteSchema } from "../../infra/sqlite-schema-facts.js";
import { SqliteWorkerBroker } from "../../infra/sqlite-worker-broker.js";
import { createRuntimeAuthProfileRowsCache } from "./runtime-persisted-rows.js";
import { readAuthProfileRows } from "./sqlite-json.js";
import type { AuthProfileRowRead } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function emptyRows(): AuthProfileRowRead {
  return {
    store: { status: "readable", raw: { version: 1, profiles: {} } },
    state: { status: "readable", raw: { lastGood: {} } },
    cacheable: true,
  };
}

it("refreshes published owners without a retained row baseline", async () => {
  const databasePath = path.join(tempDirs.make("auth-row-unprepared-"), "auth.sqlite");
  const cache = createRuntimeAuthProfileRowsCache(() => "1");
  expect(await cache.refreshChanged(path.dirname(databasePath), [databasePath])).toEqual([
    databasePath,
  ]);
});

it("does not refresh an unprepared owner replaced during observation", async () => {
  const databasePath = path.join(tempDirs.make("auth-row-unprepared-retired-"), "auth.sqlite");
  let revision = "1";
  const cache = createRuntimeAuthProfileRowsCache(() => revision);
  const observed = cache.refreshChanged(path.dirname(databasePath), [databasePath]);
  revision = "2";
  expect(await observed).toEqual([]);
});

it("retains cached credentials when an observed database change leaves auth rows unchanged", async () => {
  const databasePath = path.join(tempDirs.make("auth-row-observation-"), "auth.sqlite");
  using database = openNodeSqliteDatabase(databasePath);
  database.exec("CREATE TABLE cache_fixture (value)");
  const cache = createRuntimeAuthProfileRowsCache(() => "1");
  const read = vi.fn(async () => emptyRows());
  const refresh = vi.fn(async () => emptyRows());
  const resolve = () => cache.prepare(databasePath, { read, assertCurrent() {} }, refresh).read();
  const first = await resolve();

  expect(await cache.refreshChanged(path.dirname(databasePath))).toEqual([]);
  expect(await resolve()).toBe(first);
  expect(read).toHaveBeenCalledOnce();
  expect(refresh).toHaveBeenCalledOnce();
});

it("retains the freshly read baseline when its resolved snapshot is published", async () => {
  const databasePath = path.join(tempDirs.make("auth-row-publication-"), "auth.sqlite");
  using database = openNodeSqliteDatabase(databasePath);
  database.exec("CREATE TABLE cache_fixture (value)");
  let revision = "1";
  const cache = createRuntimeAuthProfileRowsCache(() => revision);
  const read = vi.fn(async () => emptyRows());
  const refresh = vi.fn(async () => emptyRows());
  await cache.prepare(databasePath, { read, assertCurrent() {} }, refresh, false).read();
  revision = "2";
  cache.publishSnapshots(new Set([databasePath]));
  expect(await cache.refreshChanged(path.dirname(databasePath), [databasePath])).toEqual([]);
  expect(refresh).toHaveBeenCalledOnce();
});

it("releases retired database baselines while retaining named live owners", async () => {
  const databasePath = path.join(tempDirs.make("auth-row-retirement-"), "auth.sqlite");
  using database = openNodeSqliteDatabase(databasePath);
  database.exec("CREATE TABLE cache_fixture (value)");
  const cache = createRuntimeAuthProfileRowsCache(() => "1");
  const read = vi.fn(async () => emptyRows());
  const resolve = () => cache.prepare(databasePath, { read, assertCurrent() {} }).read();
  await resolve();
  cache.retire([{ path: databasePath }], new Set([databasePath]));
  await resolve();
  expect(read).toHaveBeenCalledOnce();
  cache.retire([{ path: databasePath }]);
  await resolve();
  expect(read).toHaveBeenCalledTimes(2);
  cache.publishSnapshots(new Set());
  await resolve();
  expect(read).toHaveBeenCalledTimes(3);
});

it.each(["changed", "unreadable", "failed"] as const)(
  "invalidates cached credentials after a %s external auth reread",
  async (outcome) => {
    const databasePath = path.join(tempDirs.make("auth-row-external-"), "auth.sqlite");
    using database = openNodeSqliteDatabase(databasePath);
    database.exec("CREATE TABLE cache_fixture (value)");
    const cache = createRuntimeAuthProfileRowsCache(() => "1");
    const read = vi.fn(async () => emptyRows());
    const refresh = async (): Promise<AuthProfileRowRead> => {
      if (outcome === "failed") {
        throw new Error("External auth source is unavailable");
      }
      return outcome === "unreadable"
        ? { store: { status: "unreadable" }, state: { status: "unreadable" }, cacheable: false }
        : { ...emptyRows(), state: { status: "readable", raw: { lastGood: { example: "new" } } } };
    };
    const resolve = () => cache.prepare(databasePath, { read, assertCurrent() {} }, refresh).read();
    const first = await resolve();

    expect(await cache.refreshChanged(path.dirname(databasePath))).toEqual([databasePath]);
    expect(await resolve()).not.toBe(first);
    expect(read).toHaveBeenCalledTimes(2);
  },
);

it.each(["cleared", "replaced", "overtaken by a write"] as const)(
  "ignores an external reread after its cached owner is %s",
  async (action) => {
    const databasePath = path.join(tempDirs.make("auth-row-retired-"), "auth.sqlite");
    using database = openNodeSqliteDatabase(databasePath);
    database.exec("CREATE TABLE cache_fixture (value)");
    const cache = createRuntimeAuthProfileRowsCache(() => "1");
    const pending = Promise.withResolvers<AuthProfileRowRead>();
    const refresh = vi.fn(() => pending.promise);
    const read = vi.fn(async () => emptyRows());
    const resolve = () => cache.prepare(databasePath, { read, assertCurrent() {} }, refresh).read();
    const first = await resolve();
    const observed = cache.refreshChanged(path.dirname(databasePath));
    await Promise.resolve();
    if (action === "overtaken by a write") {
      database.exec("INSERT INTO cache_fixture VALUES (1)");
    } else {
      cache.clear(databasePath);
    }
    const replacement = action === "replaced" ? await resolve() : undefined;
    pending.reject(new Error("Old source disappeared"));

    expect(await observed).toEqual([]);
    if (replacement) {
      expect(await resolve()).toBe(replacement);
    } else if (action === "overtaken by a write") {
      expect(await resolve()).not.toBe(first);
    }
  },
);

it("reconciles a second observation received while the first reread is pending", async () => {
  const databasePath = path.join(tempDirs.make("auth-row-coalesced-"), "auth.sqlite");
  using database = openNodeSqliteDatabase(databasePath);
  database.exec("CREATE TABLE cache_fixture (value)");
  const cache = createRuntimeAuthProfileRowsCache(() => "1");
  const pending = Promise.withResolvers<AuthProfileRowRead>();
  const refresh = vi
    .fn<() => Promise<AuthProfileRowRead>>()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue({
      ...emptyRows(),
      state: { status: "readable", raw: { lastGood: { example: "new" } } },
    });
  await cache
    .prepare(databasePath, { read: async () => emptyRows(), assertCurrent() {} }, refresh)
    .read();
  const first = cache.refreshChanged(path.dirname(databasePath));
  await Promise.resolve();
  const next = cache.refreshChanged(path.dirname(databasePath));
  expect(next).toBe(first);
  pending.resolve(emptyRows());

  expect(await first).toEqual([databasePath]);
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(await cache.refreshChanged(path.dirname(databasePath))).toEqual([]);
});

it("detects an in-place auth edit from another process without a local write receipt", async () => {
  const databasePath = path.join(tempDirs.make("auth-row-external-process-"), "auth.sqlite");
  using database = openNodeSqliteDatabase(databasePath);
  database.exec(`
    CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT);
    CREATE TABLE auth_profile_state (state_key TEXT PRIMARY KEY, state_json TEXT);
    INSERT INTO auth_profile_store VALUES ('primary', '{"version":1,"profiles":{}}');
    INSERT INTO auth_profile_state VALUES ('primary', '{"lastGood":{}}');
  `);
  admitSqliteSchema(database);
  const cache = createRuntimeAuthProfileRowsCache(() => "1");
  const read = async () => readAuthProfileRows(database, databasePath, "agent");
  const resolve = () => cache.prepare(databasePath, { read, assertCurrent() {} }, read).read();
  const first = await resolve();
  const updated = { lastGood: { example: "external:key" } };

  await promisify(execFile)(process.execPath, [
    "-e",
    `const { DatabaseSync } = require("node:sqlite");
     const db = new DatabaseSync(process.argv[1]);
     try {
       db.prepare("UPDATE auth_profile_state SET state_json = ? WHERE state_key = 'primary'").run(process.argv[2]);
     } finally {
       db.close();
     }`,
    databasePath,
    JSON.stringify(updated),
  ]);

  expect(await resolve()).toBe(first);
  expect(await cache.refreshChanged(path.dirname(databasePath))).toEqual([databasePath]);
  expect((await resolve()).state).toEqual({ status: "readable", raw: updated });
});

it("shares immutable persisted rows across cache hits", async () => {
  const databasePath = path.join(tempDirs.make("auth-row-cache-"), "auth.sqlite");
  using database = openNodeSqliteDatabase(databasePath);
  database.exec("CREATE TABLE cache_fixture (value)");
  const rows = {
    store: {
      status: "readable" as const,
      raw: {
        version: 1,
        profiles: {
          "example:key": {
            type: "api_key",
            provider: "example",
            keyRef: { source: "env", provider: "default", id: "EXAMPLE_KEY" },
          },
        },
      },
    },
    state: { status: "readable" as const, raw: { order: { example: ["example:key"] } } },
    cacheable: true,
  };
  const read = vi.fn(async () => rows);
  const cache = createRuntimeAuthProfileRowsCache(() => "1");
  const resolve = () => cache.prepare(databasePath, { read, assertCurrent: () => {} }).read();
  const first = await resolve();
  expect(await resolve()).toBe(first);
  expect(read).toHaveBeenCalledTimes(1);
  // Reject changes at every retained level, including credential refs and order arrays.
  function assertImmutable(value: unknown) {
    if (value === null || typeof value !== "object") {
      return;
    }
    expect(Reflect.set(value, "injected", true)).toBe(false);
    for (const [key, child] of Object.entries(value)) {
      expect(Reflect.set(value, key, null)).toBe(false);
      assertImmutable(child);
    }
  }
  assertImmutable(first);
  expect(await resolve()).toEqual(rows);
});

it("retains rows across session writes and invalidates them on auth writer-worker receipts", async () => {
  const databasePath = path.join(tempDirs.make("auth-row-receipts-"), "auth.sqlite");
  using database = openNodeSqliteDatabase(databasePath);
  database.exec(`
    CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT);
    CREATE TABLE auth_profile_state (state_key TEXT PRIMARY KEY, state_json TEXT);
    CREATE TABLE session_fixture (value INTEGER);
    INSERT INTO session_fixture VALUES (0);
    INSERT INTO auth_profile_store VALUES ('primary', '{"version":1,"profiles":{}}');
    INSERT INTO auth_profile_state VALUES ('primary', '{"lastGood":{}}');
  `);
  admitSqliteSchema(database);
  const broker = new SqliteWorkerBroker();
  const cache = createRuntimeAuthProfileRowsCache(() => "1");
  const read = vi.fn(async () => readAuthProfileRows(database, databasePath, "agent"));
  const resolve = () => cache.prepare(databasePath, { read, assertCurrent() {} }).read();
  const observation = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
  try {
    const store = await broker.open<AdmissionOperations>({
      moduleUrl: new URL(
        "../../infra/sqlite-database-admission.worker.test-support.ts",
        import.meta.url,
      ),
      databasePath,
      input: undefined,
    });
    const first = await resolve();
    expect(await resolve()).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
    expect(
      observation.queries.filter((sql) => /auth_profile_(store|state)/u.test(sql)),
    ).toHaveLength(1);
    await store!.execute({
      type: "writeRows",
      input: {
        sql: "UPDATE session_fixture SET value=value+1",
        sessionKeys: ["agent:fixture"],
      },
    });
    expect(await resolve()).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
    const write = () =>
      store!.execute({
        type: "writeRows",
        input: {
          sql: `UPDATE auth_profile_state SET state_json='{"lastGood":{"example":"example:key"}}'`,
        },
      });
    await write();
    expect((await resolve()).state).toEqual({
      status: "readable",
      raw: { lastGood: { example: "example:key" } },
    });
    expect(read).toHaveBeenCalledTimes(2);
    cache.clear();
    read.mockImplementationOnce(async () => {
      const rows = readAuthProfileRows(database, databasePath, "agent");
      await write();
      return rows;
    });
    await resolve();
    await resolve();
    expect(read).toHaveBeenCalledTimes(4);
    expect(
      observation.queries.filter((sql) => /data_version|wal_checkpoint|page_size/iu.test(sql)),
    ).toEqual([]);
  } finally {
    observation.restore();
    await broker.close();
  }
});

it("reads shared credentials and health together after an in-process write", () => {
  const databasePath = path.join(tempDirs.make("shared-auth-rows-"), "state.sqlite");
  using database = openNodeSqliteDatabase(databasePath);
  database.exec(`
    CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT);
    INSERT INTO config_machine_state VALUES ('authProfiles.store', '{"version":1,"profiles":{}}');
    INSERT INTO config_machine_state VALUES ('authProfiles.state', '{"lastGood":{}}');
  `);
  admitSqliteSchema(database);
  readAuthProfileRows(database, databasePath, "shared-state");
  database.exec(`
    UPDATE config_machine_state SET value_json='{"lastGood":{"example":"example:key"}}'
    WHERE state_key='authProfiles.state';
  `);
  const observation = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
  try {
    expect(readAuthProfileRows(database, databasePath, "shared-state")).toMatchObject({
      store: { status: "readable", raw: { version: 1, profiles: {} } },
      state: { status: "readable", raw: { lastGood: { example: "example:key" } } },
    });
    expect(observation.queries).toHaveLength(1);
  } finally {
    observation.restore();
  }
});

it("keeps an independently absent credential row when the legacy health table is malformed", () => {
  const databasePath = path.join(tempDirs.make("legacy-auth-rows-"), "auth.sqlite");
  using database = openNodeSqliteDatabase(databasePath);
  database.exec(`
    CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT);
    CREATE TABLE auth_profile_state (state_key TEXT PRIMARY KEY);
  `);
  admitSqliteSchema(database);
  expect(readAuthProfileRows(database, databasePath, "agent")).toEqual({
    store: { status: "missing", reason: "row" },
    state: { status: "unreadable" },
    cacheable: false,
  });
});
