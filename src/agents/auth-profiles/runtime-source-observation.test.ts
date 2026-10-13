import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { createRuntimeAuthProfileRowsCache } from "./runtime-persisted-rows.js";
import type { AuthProfileRowRead } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const emptyRows = (): AuthProfileRowRead => ({
  store: { status: "readable", raw: { version: 1, profiles: {} } },
  state: { status: "readable", raw: { lastGood: {} } },
  cacheable: true,
});

it("retains unchanged source authority when observation cannot cache its rows", async () => {
  const databasePath = path.join(tempDirs.make("auth-row-uncacheable-"), "auth.sqlite");
  using database = openNodeSqliteDatabase(databasePath);
  database.exec("CREATE TABLE cache_fixture (value)");
  const cache = createRuntimeAuthProfileRowsCache(
    () => "1",
    async () => {},
  );
  const read = vi.fn(async () => emptyRows());
  let observed = emptyRows();
  const refresh = async () => ({ ...observed, cacheable: false });
  const resolve = () => cache.prepare(databasePath, { read, assertCurrent() {} }, refresh).read();
  await resolve();

  expect(await cache.refreshChanged(path.dirname(databasePath))).toEqual([]);
  await resolve();
  expect(read).toHaveBeenCalledTimes(2);

  observed = {
    ...emptyRows(),
    state: { status: "readable", raw: { lastGood: { example: "foreign" } } },
  };
  expect(await cache.refreshChanged(path.dirname(databasePath))).toEqual([databasePath]);
});
