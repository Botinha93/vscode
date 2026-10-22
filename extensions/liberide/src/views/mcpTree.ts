import * as vscode from "vscode";
import type { McpServer } from "@nexus/shared";
import { getApiOrigin, listMcpServers } from "../api";

type Item =
  | { kind: "server"; server: McpServer }
  | { kind: "info"; label: string; tooltip?: string; command?: vscode.Command; icon?: string };

/**
 * MCP Servers view: lists the workspace's MCP servers and their per-user enabled
 * state (toggle inline). Server creation/deletion are manager-only and live in
 * the web app, so this view links there rather than exposing disabled actions.
 */
export class McpTreeProvider implements vscode.TreeDataProvider<Item> {
  private readonly emitter = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private servers: McpServer[] = [];
  private loadError: string | undefined;

  constructor(private readonly log?: (message: string) => void) {}

  refresh(): void {
    void this.reload();
  }

  private async reload(): Promise<void> {
    try {
      this.servers = await listMcpServers();
      this.loadError = undefined;
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : String(err);
      this.log?.(`[mcp] load failed: ${this.loadError}`);
    }
    this.emitter.fire(undefined);
  }

  getTreeItem(item: Item): vscode.TreeItem {
    if (item.kind === "info") {
      const tree = new vscode.TreeItem(item.label);
      tree.tooltip = item.tooltip;
      tree.command = item.command;
      if (item.icon) tree.iconPath = new vscode.ThemeIcon(item.icon);
      return tree;
    }
    const { server } = item;
    const enabled = server.enabledForUser ?? false;
    const tree = new vscode.TreeItem(server.name);
    tree.description = `${server.transport ?? "stdio"} · ${enabled ? "enabled" : "disabled"}`;
    tree.tooltip = server.description ?? (server.transport === "http" ? server.url : server.command);
    tree.contextValue = enabled ? "mcp-server-enabled" : "mcp-server-disabled";
    tree.iconPath = new vscode.ThemeIcon(enabled ? "plug" : "circle-slash");
    return tree;
  }

  getChildren(item?: Item): Item[] {
    if (item) return [];
    if (this.loadError) {
      return [{ kind: "info", label: `Failed to load MCP servers: ${this.loadError}`, icon: "error" }];
    }
    const rows: Item[] = this.servers.map((server) => ({ kind: "server", server }));
    const origin = getApiOrigin();
    rows.push({
      kind: "info",
      label: "Add or configure servers in the web app (manager only)",
      tooltip: "Creating, editing, or deleting MCP servers requires the manager role and is done in the web app.",
      icon: "link-external",
      command: origin
        ? { command: "vscode.open", title: "Open web app", arguments: [vscode.Uri.parse(origin)] }
        : undefined,
    });
    return rows;
  }

  static serverOf(item: unknown): McpServer | undefined {
    if (item && typeof item === "object" && (item as { kind?: string }).kind === "server") {
      return (item as { server: McpServer }).server;
    }
    return undefined;
  }
}
