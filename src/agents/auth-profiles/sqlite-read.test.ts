import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as resources from "../../state/openclaw-agent-db-resources.js";
import * as rootContext from "../../state/openclaw-state-worker-context.js";
import { prepareAgentAuthProfileRowsRead } from "./sqlite-read.js";
import type { AuthProfileRowRead } from "./types.js";

const child = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../infra/sqlite-readonly-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/sqlite-readonly-worker.js")>()),
  runSqliteReadOnlyWorker: child.read,
}));

const rows: AuthProfileRowRead = {
  store: { status: "readable", raw: { version: 1, profiles: {} } },
  state: { status: "missing", reason: "row" },
  cacheable: true,
};
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let databasePath: string;
let rootCurrent: boolean;
const readers = new Set<ReturnType<typeof prepareAgentAuthProfileRowsRead>>();
function prepare(env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: "/fixture" }) {
  const reader = prepareAgentAuthProfileRowsRead({
    databasePath,
    agentId: "main",
    env,
  });
  readers.add(reader);
  return reader;
}

beforeEach(() => {
  rootCurrent = true;
  databasePath = path.join(tempDirs.make("auth-row-identity-"), "auth.sqlite");
  fs.writeFileSync(databasePath, "synthetic auth database");
  vi.spyOn(rootContext, "captureOpenClawStateWorkerContext").mockReturnValue({
    environment: { OPENCLAW_STATE_DIR: "/fixture" },
    admission: {
      coordinationKey: "file:root",
      databasePath: "/fixture/state.sqlite",
      identity: { key: "file:root", canonicalPath: "/fixture/state.sqlite" },
      assertCurrent: () => {
        if (!rootCurrent) {
          throw new Error("Shared auth owner was revoked");
        }
      },
    },
  });
  child.read.mockReset().mockResolvedValue(rows);
});

afterEach(async () => {
  await Promise.all([...readers].map((reader) => reader.dispose()));
  readers.clear();
  vi.restoreAllMocks();
});

describe("prepared auth profile row reads", () => {
  it("revalidates the captured file without repeating canonical path discovery", async () => {
    const reader = prepare();
    const realpath = vi.spyOn(fs.realpathSync, "native");
    await expect(reader.read()).resolves.toEqual(rows);
    expect(realpath).not.toHaveBeenCalled();
  });

  it("retains revocable read authority even when persisted rows come from a cache", async () => {
    const reader = prepare();
    reader.assertCurrent();
    expect(resources.hasOpenClawAgentDatabaseAsyncResources()).toBe(true);
    await Promise.all(resources.revokeAgentDatabaseResources({ path: databasePath }));
    expect(() => reader.assertCurrent()).toThrow("Auth profile read owner was revoked");
    expect(child.read).not.toHaveBeenCalled();
  });
  it("rejects rows whose source identity changed before the child settled", async () => {
    const reader = prepare();
    child.read.mockImplementation(async () => {
      const replacement = `${databasePath}.replacement`;
      fs.writeFileSync(replacement, "replacement auth database");
      fs.renameSync(replacement, databasePath);
      return rows;
    });
    await expect(reader.read()).rejects.toThrow("database file identity changed");
  });

  it("rejects rows when shared owner authority changes while the child reads", async () => {
    const reader = prepare();
    child.read.mockImplementation(async () => {
      rootCurrent = false;
      return rows;
    });
    await expect(reader.read()).rejects.toThrow("Shared auth owner was revoked");
  });

  it("retains captured absence when the first session creates its database", async () => {
    fs.unlinkSync(databasePath);
    const reader = prepare();
    fs.writeFileSync(databasePath, "created auth database");
    await expect(reader.read()).resolves.toEqual({
      store: { status: "missing", reason: "database" },
      state: { status: "missing", reason: "database" },
      cacheable: false,
    });
    await reader.dispose();
    expect(() => reader.assertCurrent()).not.toThrow();
    expect(child.read).not.toHaveBeenCalled();
    await expect(prepare().read()).resolves.toEqual(rows);
    expect(child.read).toHaveBeenCalledWith(
      databasePath,
      expect.objectContaining({ expectedIdentity: expect.stringMatching(/^file:/) }),
    );
  });

  it("captures environment and retains the agent owner through child settlement", async () => {
    const registration = vi.spyOn(resources, "registerOpenClawAgentDatabaseAsyncResource");
    const env = { OPENCLAW_STATE_DIR: "/fixture/original" };
    const reader = prepare(env);
    env.OPENCLAW_STATE_DIR = "/fixture/replaced";
    const entered = createDeferredCore();
    const release = createDeferredCore<AuthProfileRowRead>();
    child.read.mockImplementation(async () => {
      entered.resolve();
      return release.promise;
    });
    const reading = reader.read();
    let disposed = false;
    let closing: Promise<void> | undefined;
    try {
      await Promise.race([
        entered.promise,
        reading.then(() => {
          throw new Error("Child was not entered");
        }),
      ]);
      expect(registration).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "main", path: databasePath }),
      );
      expect(child.read).toHaveBeenCalledWith(
        databasePath,
        expect.objectContaining({
          mode: "auth-profile-rows",
          source: "canonical",
          expectedIdentity: expect.stringMatching(/^file:/),
          env: { OPENCLAW_STATE_DIR: "/fixture/original" },
        }),
      );
      closing = reader.dispose().then(() => {
        disposed = true;
      });
      await Promise.resolve();
      expect(disposed).toBe(false);
      release.resolve(rows);
      await expect(reading).rejects.toThrow("Auth profile read owner closed");
      await closing;
      expect(disposed).toBe(true);
    } finally {
      release.resolve(rows);
      await Promise.allSettled([reading, closing ?? reader.dispose()]);
    }
  });

  it("keeps captured authority checkable after ordinary disposal but rejects new reads", async () => {
    const reader = prepare();
    await expect(reader.read()).resolves.toEqual(rows);
    await reader.dispose();
    expect(() => reader.assertCurrent()).not.toThrow();
    await expect(reader.read()).rejects.toThrow("Auth profile read owner closed");
  });
});
