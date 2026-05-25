import * as vscode from "vscode";
import { apiFetch, getApiOrigin } from "./api";

// Kept in sync with packages/shared/src/theme-bridge.ts
const CHATLLM_TO_VSCODE: Record<string, string> = {
  "default:light": "Light Modern",
  "default:dark": "Dark Modern",
  "cursor:light": "Light 2026",
  "cursor:dark": "Dark 2026",
  "github:light": "Light+",
  "github:dark": "Dark+",
  "codex:light": "Quiet Light",
  "codex:dark": "Monokai Dimmed",
  "professional:light": "Visual Studio Light",
  "professional:dark": "Visual Studio Dark",
  "clean:light": "Quiet Light",
  "clean:dark": "Dark Modern",
  "gray-blue:light": "Light Modern",
  "gray-blue:dark": "Tomorrow Night Blue",
  "aurora:light": "Light Modern",
  "aurora:dark": "Dark Modern",
  "midnight:light": "Solarized Light",
  "midnight:dark": "Abyss",
};

const VSCODE_TO_CHATLLM: Record<string, { family: string; mode: string }> = {
  "Light Modern": { family: "default", mode: "light" },
  "Dark Modern": { family: "default", mode: "dark" },
  "Light+": { family: "github", mode: "light" },
  "Dark+": { family: "github", mode: "dark" },
  "Light 2026": { family: "cursor", mode: "light" },
  "Dark 2026": { family: "cursor", mode: "dark" },
  "Visual Studio Light": { family: "professional", mode: "light" },
  "Visual Studio Dark": { family: "professional", mode: "dark" },
  "Quiet Light": { family: "codex", mode: "light" },
  "Monokai Dimmed": { family: "codex", mode: "dark" },
  "Monokai": { family: "codex", mode: "dark" },
  "Tomorrow Night Blue": { family: "gray-blue", mode: "dark" },
  "Solarized Light": { family: "midnight", mode: "light" },
  "Solarized Dark": { family: "midnight", mode: "dark" },
  "Abyss": { family: "midnight", mode: "dark" },
  "Kimbie Dark": { family: "midnight", mode: "dark" },
  Red: { family: "midnight", mode: "dark" },
  "Default Light Modern": { family: "default", mode: "light" },
  "Default Dark Modern": { family: "default", mode: "dark" },
  "Default Light+": { family: "github", mode: "light" },
  "Default Dark+": { family: "github", mode: "dark" },
  "GitHub Dark Default": { family: "github", mode: "dark" },
  "GitHub Light Default": { family: "github", mode: "light" },
};

export function createThemeBridge(output: vscode.OutputChannel): vscode.Disposable {
  const apiOrigin = getApiOrigin();
  if (!apiOrigin) {
    output.appendLine("Theme sync disabled: CHATLLM_API_ORIGIN is not set.");
    return { dispose: () => {} };
  }

  let lastAppliedFromRemote: string | null = null;
  let lastPublishedThemeId: string | null = null;
  let ws: WebSocket | null = null;
  let wsClosed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelayMs = 1000;

  function vsCodeThemeIdFromEnv(): string | null {
    const family = process.env.CHATLLM_THEME_FAMILY;
    const mode = process.env.CHATLLM_THEME_MODE;
    if (!family || !mode) return null;
    const effective = mode === "system" ? "dark" : mode;
    return CHATLLM_TO_VSCODE[`${family}:${effective}`] || null;
  }

  async function applyThemeId(themeId: string | null | undefined, fromRemote: boolean) {
    if (!themeId) return;
    const config = vscode.workspace.getConfiguration("workbench");
    const current = config.get<string>("colorTheme");
    if (current === themeId) return;
    if (fromRemote) lastAppliedFromRemote = themeId;
    try {
      await config.update("colorTheme", themeId, vscode.ConfigurationTarget.Global);
      output.appendLine(`Applied VS Code theme '${themeId}'${fromRemote ? " (from Chatllm)" : ""}.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output.appendLine(`Failed to apply VS Code theme '${themeId}': ${message}`);
    }
  }

  async function publishCurrentTheme() {
    const config = vscode.workspace.getConfiguration("workbench");
    const themeId = config.get<string>("colorTheme");
    if (!themeId) return;
    if (themeId === lastAppliedFromRemote) {
      lastAppliedFromRemote = null;
      lastPublishedThemeId = themeId;
      return;
    }
    if (themeId === lastPublishedThemeId) return;

    const mapped = VSCODE_TO_CHATLLM[themeId];
    if (!mapped) {
      output.appendLine(
        `No Chatllm mapping for VS Code theme '${themeId}'; the Chatllm window will keep its current theme.`,
      );
      return;
    }

    const snapshot = {
      kind: "name",
      family: mapped.family,
      mode: mapped.mode,
      vsCodeThemeId: themeId,
      source: "vscode",
    };

    try {
      const response = await apiFetch("/api/theme", {
        method: "PUT",
        body: JSON.stringify(snapshot),
      });
      if (!response.ok) {
        output.appendLine(`Theme publish failed (${response.status}): ${await response.text().catch(() => "")}`);
        return;
      }
      lastPublishedThemeId = themeId;
      output.appendLine(`Published VS Code theme '${themeId}' → Chatllm (${mapped.family}/${mapped.mode}).`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output.appendLine(`Theme publish error: ${message}`);
    }
  }

  function connectStream() {
    if (wsClosed) return;
    const wsUrl = `${apiOrigin.replace(/^http/, "ws")}/api/theme/stream`;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output.appendLine(`Theme stream connect failed: ${message}`);
      scheduleReconnect();
      return;
    }

    ws.addEventListener("open", () => {
      reconnectDelayMs = 1000;
    });

    ws.addEventListener("message", (event) => {
      let payload: { type?: string; snapshot?: { source?: string; kind?: string; vsCodeThemeId?: string; family?: string; mode?: string } };
      try {
        payload = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      if (!payload || payload.type !== "theme" || !payload.snapshot) return;
      const snapshot = payload.snapshot;
      if (snapshot.source === "vscode") return;
      if (snapshot.kind === "name") {
        const themeId =
          snapshot.vsCodeThemeId ||
          CHATLLM_TO_VSCODE[`${snapshot.family}:${snapshot.mode === "system" ? "dark" : snapshot.mode}`];
        void applyThemeId(themeId, true);
      }
    });

    ws.addEventListener("close", () => {
      ws = null;
      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // close handler reconnects
    });
  }

  function scheduleReconnect() {
    if (wsClosed || reconnectTimer) return;
    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectStream();
    }, delay);
  }

  const initialThemeId = vsCodeThemeIdFromEnv();
  if (initialThemeId) void applyThemeId(initialThemeId, true);

  const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("workbench.colorTheme")) {
      void publishCurrentTheme();
    }
  });

  connectStream();
  void publishCurrentTheme();

  return {
    dispose() {
      wsClosed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        try {
          ws.close();
        } catch {
          // ignore
        }
        ws = null;
      }
      configListener.dispose();
    },
  };
}
