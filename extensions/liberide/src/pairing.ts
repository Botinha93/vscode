import * as vscode from "vscode";
import { hostname } from "node:os";
import { getApiOrigin, normalizeServerUrl, pairWithServer } from "./api";
import { currentMachineId } from "./ide-delegate/machine";

const PAIRING_CODE_LENGTH = 8;

/** `LiberIDE: Pair with Server…`: exchange a code from Settings → Machines for a token bound to this machine. */
export async function pairWithServerCommand(output: vscode.OutputChannel): Promise<void> {
  const serverUrl = await vscode.window.showInputBox({
    title: "Pair with Server",
    prompt: "URL of the server to connect this machine to",
    placeHolder: "https://chat.example.com",
    value: getApiOrigin() || undefined,
    ignoreFocusOut: true,
    validateInput: (value) => (normalizeServerUrl(value) ? undefined : "Enter an http(s) URL"),
  });
  if (!serverUrl) return;
  const code = await vscode.window.showInputBox({
    title: "Pair with Server",
    prompt: "Pairing code from Settings → Machines → Connect a machine",
    placeHolder: "ABCD-EFGH",
    ignoreFocusOut: true,
    validateInput: (value) => (value.replace(/[\s-]/g, "").length === PAIRING_CODE_LENGTH ? undefined : "The code has 8 characters"),
  });
  if (!code) return;
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Pairing with server…" },
    () => pairWithServer({ serverUrl, code, machineId: currentMachineId(), hostname: hostname(), platform: process.platform }),
  );
  output.appendLine(`[pairing] paired with ${result.apiOrigin} as machine ${result.machineId}`);
  void vscode.window.showInformationMessage(`LiberIDE is now connected to ${result.apiOrigin}.`);
}
