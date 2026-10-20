import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "liberide-machine-"));
const integrationFile = path.join(dir, "libervox-integration.json");
process.env.LIBERVOX_INTEGRATION_FILE = integrationFile;

const { reloadAuth } = await import("../src/api");
const { MACHINE_ID_STATE_KEY, currentMachineId, initMachineIdentity, resetMachineIdentity, setWorkspaceId, workspaceIdFor } = await import("../src/ide-delegate/machine");

function memento(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: (key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    },
  };
}

afterAll(() => {
  delete process.env.LIBERVOX_INTEGRATION_FILE;
  rmSync(dir, { recursive: true, force: true });
});

describe("machine identity", () => {
  beforeEach(() => {
    resetMachineIdentity();
    rmSync(integrationFile, { force: true });
    reloadAuth();
  });

  test("is created once and persisted in globalState", () => {
    const state = memento();
    const first = initMachineIdentity({ globalState: state, extension: { packageJSON: { version: "1.2.3" } } });
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(state.values.get(MACHINE_ID_STATE_KEY)).toBe(first);

    resetMachineIdentity();
    expect(initMachineIdentity({ globalState: state })).toBe(first);
  });

  test("a machine id in the integration file (desktop) wins over globalState", () => {
    const state = memento({ [MACHINE_ID_STATE_KEY]: "11111111-1111-4111-8111-111111111111" });
    writeFileSync(integrationFile, JSON.stringify({ apiOrigin: "http://127.0.0.1:1", authToken: "t", machineId: "22222222-2222-4222-8222-222222222222" }));
    reloadAuth();
    expect(initMachineIdentity({ globalState: state })).toBe("22222222-2222-4222-8222-222222222222");
    expect(state.values.get(MACHINE_ID_STATE_KEY)).toBe("11111111-1111-4111-8111-111111111111");
  });

  test("an invalid stored id is replaced", () => {
    const state = memento({ [MACHINE_ID_STATE_KEY]: "not-a-uuid" });
    const id = initMachineIdentity({ globalState: state });
    expect(id).not.toBe("not-a-uuid");
    expect(currentMachineId()).toBe(id);
  });

  test("workspace ids from hello.ack are kept per folder", () => {
    setWorkspaceId("/repo", "w1");
    expect(workspaceIdFor("/repo")).toBe("w1");
    expect(workspaceIdFor("/other")).toBeUndefined();
  });
});
