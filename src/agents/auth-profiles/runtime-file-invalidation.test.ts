import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreSnapshotAtDatabasePath,
  registerRuntimeAuthProfileExternalRefresh,
  setRuntimeAuthProfileStoreSnapshotAtDatabasePath,
} from "./runtime-snapshots.js";
import type { AuthProfileStore } from "./types.js";

const observation = vi.hoisted(() => ({
  listeners: new Set<
    (change: { directory: string; identityChanged: boolean; sourcesChanged: boolean }) => void
  >(),
}));

// mock-isolation: Supply file events without native watches to prove snapshot retirement and refresh settlement.
vi.mock("./file-state.js", () => ({
  closeAuthProfileFileState() {},
  noteAuthProfileFileWrite() {},
  refreshAuthProfileFileState: async () => {},
  authProfileSourceExists: () => false,
  readAuthProfileDatabaseIdentity: vi.fn(),
  captureAuthProfileFileIdentity: vi.fn(),
  registerAuthProfileFileChangeListener: (
    listener: (change: {
      directory: string;
      identityChanged: boolean;
      sourcesChanged: boolean;
    }) => void,
  ) => {
    observation.listeners.add(listener);
    return () => observation.listeners.delete(listener);
  },
}));

const sharedDatabase = "/tmp/auth-file-invalidation/shared/openclaw-agent.sqlite";
const agentDatabase = "/tmp/auth-file-invalidation/agent/openclaw-agent.sqlite";

function publishAgent(key: string): void {
  const store: AuthProfileStore = {
    version: 1,
    profiles: { example: { type: "api_key", provider: "example", key } },
  };
  setRuntimeAuthProfileStoreSnapshotAtDatabasePath(
    store,
    agentDatabase,
    path.dirname(agentDatabase),
    { databasePath: agentDatabase, sharedDatabasePath: sharedDatabase, location: "legacy-main" },
  );
}

function observeSharedReplacement(): void {
  for (const listener of observation.listeners) {
    listener({
      directory: path.dirname(sharedDatabase),
      identityChanged: true,
      sourcesChanged: false,
    });
  }
}

beforeEach(() => clearRuntimeAuthProfileStoreSnapshots());
afterEach(() => clearRuntimeAuthProfileStoreSnapshots());

it("retires an inherited snapshot when its shared database changes without a shared snapshot", async () => {
  const refreshed = Promise.withResolvers<boolean>();
  registerRuntimeAuthProfileExternalRefresh(() => refreshed.promise);
  publishAgent("inherited");
  expect(getRuntimeAuthProfileStoreSnapshotAtDatabasePath(sharedDatabase)).toBeUndefined();
  expect(getRuntimeAuthProfileStoreSnapshotAtDatabasePath(agentDatabase)).toBeDefined();

  observeSharedReplacement();

  expect(getRuntimeAuthProfileStoreSnapshotAtDatabasePath(agentDatabase)).toBeUndefined();
  refreshed.resolve(true);
  await refreshed.promise;
});

it.each(["declined", "failed"] as const)(
  "keeps replacement snapshots when an earlier lifecycle's external refresh %s",
  async (outcome) => {
    const started = Promise.withResolvers<void>();
    const refreshed = Promise.withResolvers<boolean>();
    registerRuntimeAuthProfileExternalRefresh(() => {
      started.resolve();
      return refreshed.promise;
    });
    publishAgent("before");
    observeSharedReplacement();
    await started.promise;

    clearRuntimeAuthProfileStoreSnapshots();
    publishAgent("replacement");
    if (outcome === "declined") {
      refreshed.resolve(false);
    } else {
      refreshed.reject(new Error("Previous lifecycle refresh failed"));
    }
    await refreshed.promise.catch(() => undefined);

    expect(
      getRuntimeAuthProfileStoreSnapshotAtDatabasePath(agentDatabase)?.profiles.example,
    ).toEqual({
      type: "api_key",
      provider: "example",
      key: "replacement",
    });
  },
);
