import { randomUUID } from "node:crypto";
import { getIntegrationMachineId, UUID_PATTERN } from "../api";

/**
 * This install's machine identity. The desktop app writes a stable id into
 * the integration file, which wins so all its windows are one machine;
 * otherwise a uuid is generated once and kept in the extension's globalState.
 */

export const MACHINE_ID_STATE_KEY = "liberide.machineId";

interface MachineMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

let storedMachineId: string | undefined;
let extensionVersion: string | undefined;
/** Workspace id per folder path, from the server's `hello.ack`. */
const workspaceIds = new Map<string, string>();

export function initMachineIdentity(context: {
  globalState: MachineMemento;
  extension?: { packageJSON?: { version?: unknown } };
}): string {
  const existing = context.globalState.get<string>(MACHINE_ID_STATE_KEY);
  if (typeof existing === "string" && UUID_PATTERN.test(existing)) {
    storedMachineId = existing.toLowerCase();
  } else {
    storedMachineId = randomUUID();
    void context.globalState.update(MACHINE_ID_STATE_KEY, storedMachineId);
  }
  const version = context.extension?.packageJSON?.version;
  extensionVersion = typeof version === "string" ? version : undefined;
  return currentMachineId();
}

export function currentMachineId(): string {
  const fromFile = getIntegrationMachineId();
  if (fromFile) return fromFile;
  storedMachineId ??= randomUUID();
  return storedMachineId;
}

export function currentExtensionVersion(): string | undefined {
  return extensionVersion;
}

export function setWorkspaceId(rootPath: string, workspaceId: string): void {
  workspaceIds.set(rootPath, workspaceId);
}

export function workspaceIdFor(rootPath: string): string | undefined {
  return workspaceIds.get(rootPath);
}

/** @internal test helper */
export function resetMachineIdentity(): void {
  storedMachineId = undefined;
  extensionVersion = undefined;
  workspaceIds.clear();
}
