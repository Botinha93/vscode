import * as vscode from "vscode";
import { apiFetch, getApiOrigin } from "./api";

const CHATLLM_TO_VSCODE: Record<string, string> = {
  "default:light": "Light Modern",
  "default:dark": "Dark Modern",
  "cursor:light": "Light 2026",
  "cursor:dark": "Dark 2026",
  "github:light": "Light+",
  "github:dark": "Dark+",
};

const VSCODE_TO_CHATLLM: Record<string, { family: string; mode: string }> = {
  "Light Modern": { family: "default", mode: "light" },
  "Dark Modern": { family: "default", mode: "dark" },
  "Light+": { family: "github", mode: "light" },
  "Dark+": { family: "github", mode: "dark" },
  "Light 2026": { family: "cursor", mode: "light" },
  "Dark 2026": { family: "cursor", mode: "dark" },
};

type ThemeSnapshotPayload = {
  source?: string;
  vsCodeThemeId?: string;
  family?: string;
  mode?: string;
  colorOverrides?: Record<string, string>;
};

export function createThemeBridge(output: vscode.OutputChannel): vscode.Disposable {
  const apiOrigin = getApiOrigin();
  if (!apiOrigin) return { dispose() {} };
  let ws: WebSocket | undefined;
  let disposed = false;
  let lastApplied: string | undefined;
  let lastOverridesKey: string | undefined;

  async function applyTheme(themeId?: string): Promise<void> {
    if (!themeId) return;
    lastApplied = themeId;
    await vscode.workspace.getConfiguration("workbench").update("colorTheme", themeId, vscode.ConfigurationTarget.Global);
  }

  /**
   * Mirror the Chatllm web app's palette by writing concrete hex colors into
   * `workbench.colorCustomizations` at the user (Global) scope. Theme-scoped
   * sections like `"[Dark Modern]": {...}` that the user maintains by hand are
   * preserved; only the unscoped keys (which is where these overrides live)
   * are replaced on each apply. Repeated payloads with the same JSON shape are
   * short-circuited to avoid spurious settings.json churn.
   */
  async function applyColorOverrides(overrides: Record<string, string> | undefined): Promise<void> {
    if (!overrides || Object.keys(overrides).length === 0) return;
    const fingerprint = JSON.stringify(overrides);
    if (fingerprint === lastOverridesKey) return;
    lastOverridesKey = fingerprint;
    const config = vscode.workspace.getConfiguration("workbench");
    const existing = (config.get<Record<string, unknown>>("colorCustomizations") ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = { ...overrides };
    for (const [key, value] of Object.entries(existing)) {
      if (key.startsWith("[") && key.endsWith("]")) next[key] = value;
    }
    await config.update("colorCustomizations", next, vscode.ConfigurationTarget.Global);
  }

  async function publishTheme() {
    const themeId = vscode.workspace.getConfiguration("workbench").get<string>("colorTheme");
    if (!themeId || themeId === lastApplied) {
      lastApplied = undefined;
      return;
    }
    const mapped = VSCODE_TO_CHATLLM[themeId];
    if (!mapped) return;
    await apiFetch("/api/theme", {
      method: "PUT",
      body: JSON.stringify({ kind: "name", family: mapped.family, mode: mapped.mode, vsCodeThemeId: themeId, source: "vscode" }),
    }).catch((error) => output.appendLine(`Theme publish error: ${error instanceof Error ? error.message : String(error)}`));
  }

  function connect() {
    if (disposed) return;
    ws = new WebSocket(`${apiOrigin.replace(/^http/, "ws")}/api/theme/stream`);
    ws.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data)) as { type?: string; snapshot?: ThemeSnapshotPayload };
      if (payload.type !== "theme" || payload.snapshot?.source === "vscode") return;
      const snapshot = payload.snapshot;
      const themeId = snapshot?.vsCodeThemeId ?? CHATLLM_TO_VSCODE[`${snapshot?.family}:${snapshot?.mode}`];
      void applyTheme(themeId).then(() => applyColorOverrides(snapshot?.colorOverrides));
    });
    ws.addEventListener("close", () => setTimeout(connect, 1000));
  }

  const envTheme = CHATLLM_TO_VSCODE[`${process.env.CHATLLM_THEME_FAMILY}:${process.env.CHATLLM_THEME_MODE === "system" ? "dark" : process.env.CHATLLM_THEME_MODE}`];
  void applyTheme(envTheme);
  const listener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("workbench.colorTheme")) void publishTheme();
  });
  connect();
  void publishTheme();
  return { dispose() { disposed = true; listener.dispose(); ws?.close(); } };
}
