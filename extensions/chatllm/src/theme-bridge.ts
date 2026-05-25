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

export function createThemeBridge(output: vscode.OutputChannel): vscode.Disposable {
  const apiOrigin = getApiOrigin();
  if (!apiOrigin) return { dispose() {} };
  let ws: WebSocket | undefined;
  let disposed = false;
  let lastApplied: string | undefined;

  async function applyTheme(themeId?: string) {
    if (!themeId) return;
    lastApplied = themeId;
    await vscode.workspace.getConfiguration("workbench").update("colorTheme", themeId, vscode.ConfigurationTarget.Global);
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
      const payload = JSON.parse(String(event.data)) as { type?: string; snapshot?: { source?: string; vsCodeThemeId?: string; family?: string; mode?: string } };
      if (payload.type !== "theme" || payload.snapshot?.source === "vscode") return;
      void applyTheme(payload.snapshot?.vsCodeThemeId ?? CHATLLM_TO_VSCODE[`${payload.snapshot?.family}:${payload.snapshot?.mode}`]);
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
