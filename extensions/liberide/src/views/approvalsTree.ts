import * as vscode from "vscode";
import type { ApprovalGrant, PermissionPolicy } from "@nexus/shared";
import { getApiOrigin, listApprovalGrants, listPermissionPolicies } from "../api";

type Section = "grants" | "history" | "policies";

type Item =
  | { kind: "section"; section: Section; label: string }
  | { kind: "grant"; grant: ApprovalGrant; active: boolean }
  | { kind: "policy"; policy: PermissionPolicy }
  | { kind: "info"; label: string; tooltip?: string; command?: vscode.Command; icon?: string };

function grantActive(grant: ApprovalGrant): boolean {
  if (grant.revoked) return false;
  if (grant.expiresAt && new Date(grant.expiresAt).getTime() <= Date.now()) return false;
  if (grant.maxUses !== undefined && grant.usedCount >= grant.maxUses) return false;
  return true;
}

/**
 * Approvals & Permissions view: an in-IDE audit trail of approval grants
 * (active + history, with revoke) and a read-only view of the effective
 * permission policy per scope (gap #7 and #10).
 */
export class ApprovalsTreeProvider implements vscode.TreeDataProvider<Item> {
  private readonly emitter = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private grants: ApprovalGrant[] = [];
  private policies: PermissionPolicy[] | undefined;
  private policiesForbidden = false;
  private loadError: string | undefined;

  constructor(private readonly log?: (message: string) => void) {}

  refresh(): void {
    void this.reload();
  }

  private async reload(): Promise<void> {
    try {
      this.grants = await listApprovalGrants();
      this.loadError = undefined;
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : String(err);
      this.log?.(`[approvals] grants load failed: ${this.loadError}`);
    }
    try {
      const result = await listPermissionPolicies();
      this.policies = result.policies;
      this.policiesForbidden = Boolean(result.forbidden);
    } catch (err) {
      this.policies = undefined;
      this.log?.(`[approvals] policies load failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.emitter.fire(undefined);
  }

  getTreeItem(item: Item): vscode.TreeItem {
    switch (item.kind) {
      case "section": {
        const tree = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.Expanded);
        tree.contextValue = `approvals-section-${item.section}`;
        return tree;
      }
      case "grant": {
        const label = item.grant.resourcePattern
          ? `${item.grant.scope} · ${item.grant.resourcePattern}`
          : item.grant.scope;
        const tree = new vscode.TreeItem(label);
        const uses = item.grant.maxUses !== undefined
          ? `${item.grant.usedCount}/${item.grant.maxUses} uses`
          : `${item.grant.usedCount} uses`;
        const expiry = item.grant.revoked
          ? "revoked"
          : item.grant.expiresAt
            ? `expires ${new Date(item.grant.expiresAt).toLocaleString()}`
            : "no expiry";
        tree.description = `${item.grant.issuer} · ${uses} · ${expiry}`;
        tree.tooltip = `Granted ${new Date(item.grant.createdAt).toLocaleString()}`;
        tree.contextValue = item.active ? "approval-grant-active" : "approval-grant-inactive";
        tree.iconPath = new vscode.ThemeIcon(item.active ? "shield" : "circle-slash");
        return tree;
      }
      case "policy": {
        const tree = new vscode.TreeItem(item.policy.scope);
        tree.description = item.policy.requiresApproval
          ? `approval required · ${item.policy.riskLevel}`
          : `auto · ${item.policy.riskLevel}`;
        tree.tooltip = item.policy.description ?? item.policy.scope;
        tree.iconPath = new vscode.ThemeIcon(item.policy.requiresApproval ? "lock" : "unlock");
        return tree;
      }
      case "info": {
        const tree = new vscode.TreeItem(item.label);
        tree.tooltip = item.tooltip;
        tree.command = item.command;
        if (item.icon) tree.iconPath = new vscode.ThemeIcon(item.icon);
        return tree;
      }
    }
  }

  getChildren(item?: Item): Item[] {
    if (!item) {
      return [
        { kind: "section", section: "grants", label: "Active Grants" },
        { kind: "section", section: "history", label: "Grant History" },
        { kind: "section", section: "policies", label: "Permission Policies" },
      ];
    }
    if (item.kind !== "section") return [];

    if (item.section === "grants") {
      if (this.loadError) {
        return [{ kind: "info", label: `Failed to load grants: ${this.loadError}`, icon: "error" }];
      }
      const active = this.grants.filter(grantActive);
      if (active.length === 0) return [{ kind: "info", label: "No active grants", icon: "check" }];
      return active.map((grant) => ({ kind: "grant", grant, active: true }));
    }

    if (item.section === "history") {
      if (this.grants.length === 0) return [{ kind: "info", label: "No grant history", icon: "history" }];
      return this.grants.map((grant) => ({ kind: "grant", grant, active: grantActive(grant) }));
    }

    // policies
    if (this.policiesForbidden) {
      const origin = getApiOrigin();
      return [
        {
          kind: "info",
          label: "Managed in the web app (manager only)",
          tooltip: "Permission policies require the manager role. Open the web app to view or change them.",
          icon: "link-external",
          command: origin
            ? { command: "vscode.open", title: "Open web app", arguments: [vscode.Uri.parse(origin)] }
            : undefined,
        },
      ];
    }
    if (!this.policies) {
      return [{ kind: "info", label: "Policies unavailable", icon: "warning" }];
    }
    return this.policies.map((policy) => ({ kind: "policy", policy }));
  }

  /** Returns the grant id for a revoke command argument. */
  static grantIdOf(item: unknown): string | undefined {
    if (item && typeof item === "object" && (item as { kind?: string }).kind === "grant") {
      return (item as { grant: ApprovalGrant }).grant.id;
    }
    return undefined;
  }
}
