import * as vscode from "vscode";
import { apiFetch, getApiOrigin } from "./api";

const NEXUS_TO_VSCODE: Record<string, string> = {
  "default:light": "Light Modern",
  "default:dark": "Dark Modern",
  "cursor:light": "Light 2026",
  "cursor:dark": "Dark 2026",
  "github:light": "Light+",
  "github:dark": "Dark+",
  // Nord doesn't ship its own built-in theme; the published color +
  // tokenColor overrides repaint the workbench and syntax to Nord.
  "nord:light": "Light Modern",
  "nord:dark": "Dark Modern",
};

const VSCODE_TO_NEXUS: Record<string, { family: string; mode: string }> = {
  "Light Modern": { family: "default", mode: "light" },
  "Dark Modern": { family: "default", mode: "dark" },
  "Light+": { family: "github", mode: "light" },
  "Dark+": { family: "github", mode: "dark" },
  "Light 2026": { family: "cursor", mode: "light" },
  "Dark 2026": { family: "cursor", mode: "dark" },
};

interface TextMateRule {
  scope: string | string[];
  settings: { foreground?: string; background?: string; fontStyle?: string };
}

interface TokenColorOverrides {
  textMateRules: TextMateRule[];
  semanticHighlighting?: boolean;
  semanticTokenColors?: Record<string, string | { foreground?: string; fontStyle?: string }>;
}

type ThemeSnapshotPayload = {
  source?: string;
  vsCodeThemeId?: string;
  family?: string;
  mode?: string;
  colorOverrides?: Record<string, string>;
  tokenColorOverrides?: TokenColorOverrides;
};

export function createThemeBridge(output: vscode.OutputChannel): vscode.Disposable {
  const apiOrigin = getApiOrigin();
  if (!apiOrigin) return { dispose() {} };
  let ws: WebSocket | undefined;
  let disposed = false;
  let lastApplied: string | undefined;
  let lastOverridesKey: string | undefined;
  let lastTokenOverridesKey: string | undefined;

  async function applyTheme(themeId?: string): Promise<void> {
    if (!themeId) return;
    lastApplied = themeId;
    await vscode.workspace.getConfiguration("workbench").update("colorTheme", themeId, vscode.ConfigurationTarget.Global);
  }

  /**
   * Mirror the LiberIDE web app's palette by writing concrete hex colors into
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

  /**
   * Apply the Nord-aligned syntax palette published by the web app via
   * `editor.tokenColorCustomizations`. The LiberIDE palette flows in as a
   * resolved `{ textMateRules, semanticHighlighting, semanticTokenColors }`
   * object so we can write it through without inspecting the base theme.
   * As with `applyColorOverrides`, theme-scoped customizations the user
   * maintains by hand (`"[Dark Modern]": { … }`) are preserved.
   */
  async function applyTokenColorOverrides(overrides: TokenColorOverrides | undefined): Promise<void> {
    if (!overrides || !overrides.textMateRules || overrides.textMateRules.length === 0) return;
    const fingerprint = JSON.stringify(overrides);
    if (fingerprint === lastTokenOverridesKey) return;
    lastTokenOverridesKey = fingerprint;
    const config = vscode.workspace.getConfiguration("editor");
    const existing = (config.get<Record<string, unknown>>("tokenColorCustomizations") ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = {
      textMateRules: overrides.textMateRules,
      semanticHighlighting: overrides.semanticHighlighting ?? true,
    };
    if (overrides.semanticTokenColors) {
      next.semanticTokenColors = overrides.semanticTokenColors;
    }
    for (const [key, value] of Object.entries(existing)) {
      if (key.startsWith("[") && key.endsWith("]")) next[key] = value;
    }
    await config.update("tokenColorCustomizations", next, vscode.ConfigurationTarget.Global);
  }

  async function publishTheme() {
    const themeId = vscode.workspace.getConfiguration("workbench").get<string>("colorTheme");
    if (!themeId || themeId === lastApplied) {
      lastApplied = undefined;
      return;
    }
    const mapped = VSCODE_TO_NEXUS[themeId];
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
      const themeId = snapshot?.vsCodeThemeId ?? NEXUS_TO_VSCODE[`${snapshot?.family}:${snapshot?.mode}`];
      void applyTheme(themeId)
        .then(() => applyColorOverrides(snapshot?.colorOverrides))
        .then(() => applyTokenColorOverrides(snapshot?.tokenColorOverrides));
    });
    ws.addEventListener("close", () => setTimeout(connect, 1000));
  }

  const envTheme = NEXUS_TO_VSCODE[`${process.env.LIBERVOX_THEME_FAMILY}:${process.env.LIBERVOX_THEME_MODE === "system" ? "dark" : process.env.LIBERVOX_THEME_MODE}`];
  void applyTheme(envTheme);
  const listener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("workbench.colorTheme")) void publishTheme();
  });
  connect();
  void publishTheme();
  return { dispose() { disposed = true; listener.dispose(); ws?.close(); } };
}
