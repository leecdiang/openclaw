import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  getRuntimeAuthProfileStoreSnapshotCore,
  refreshRuntimeAuthProfileStoreSources,
  registerRuntimeAuthProfileStoreMutationListener,
} from "../agents/auth-profiles/runtime-snapshots.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import {
  loadAuthProfileStoreForRuntimeAsync,
  saveAuthProfileStore,
} from "../agents/auth-profiles/store-runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
  refreshActiveProviderAuthRuntimeSnapshot,
} from "./runtime.js";

const observations = vi.hoisted(() => new Map<string, Set<(filename?: string) => void>>());
// mock-isolation: Native delivery is covered by its owner; this file proves credential publication.
vi.mock("../infra/owned-directory-observation.js", () => ({
  observeOwnedDirectory(directory: string, notify: (filename?: string) => void) {
    const callbacks = observations.get(directory) ?? new Set<(filename?: string) => void>();
    observations.set(directory, callbacks);
    callbacks.add(notify);
    return { close: () => callbacks.delete(notify) };
  },
}));

const temporary = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  clearSecretsRuntimeSnapshot();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
});

it.each(["observation", "explicit refresh"] as const)(
  "publishes a separate process's auth edit through %s",
  async (refresh) => {
    const root = temporary.make("auth-observation-publication-");
    const agentDir = path.join(root, "agents", "main", "agent");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const store = (key: string) => ({
      version: 1,
      profiles: { example: { type: "api_key" as const, provider: "openai", key } },
    });
    saveAuthProfileStore(store("synthetic-before"), agentDir, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: {
        agents: { ownership: "explicit", entries: { main: { agentDir, workspace: root } } },
        plugins: { enabled: false },
      },
      env: { HOME: root, OPENCLAW_STATE_DIR: root },
      includeConfigRefs: false,
    });
    activateSecretsRuntimeSnapshot(snapshot);
    await loadAuthProfileStoreForRuntimeAsync(agentDir, {
      readOnly: true,
      externalCli: { mode: "none" },
    });
    await promisify(execFile)(process.execPath, [
      "-e",
      'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); try { db.prepare("UPDATE auth_profile_store SET store_json = ? WHERE store_key = ?").run(process.argv[2], "primary"); } finally { db.close(); }',
      resolveAuthProfileDatabasePath(agentDir),
      JSON.stringify(store("synthetic-after")),
    ]);
    if (refresh === "explicit refresh") {
      await refreshRuntimeAuthProfileStoreSources();
      await refreshActiveProviderAuthRuntimeSnapshot();
    } else {
      const published = new Promise<void>((resolve) => {
        const unsubscribe = registerRuntimeAuthProfileStoreMutationListener(() => {
          unsubscribe();
          resolve();
        });
      });
      const callbacks = observations.get(path.dirname(resolveAuthProfileDatabasePath(agentDir)));
      expect(callbacks?.size).toBeGreaterThan(0);
      for (const notify of callbacks ?? []) {
        notify();
      }
      await published;
    }
    expect(getRuntimeAuthProfileStoreSnapshotCore(agentDir)?.profiles.example).toMatchObject({
      type: "api_key",
      key: "synthetic-after",
    });
    expect(
      getActiveSecretsRuntimeSnapshot()?.authStores.find((entry) => entry.agentDir === agentDir)
        ?.store.profiles.example,
    ).toMatchObject({
      type: "api_key",
      key: "synthetic-after",
    });
  },
);
