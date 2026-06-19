import type { LiberideSettings } from "../settings";
import type { GraphArtifact, GraphApprovalSummary, GraphMetrics, GraphNodeSummary, WorkingMemorySnapshot } from "../dispatch/client";

export interface FeatureSummary {
  id: string;
  name: string;
  status: string;
  requirementCount: number;
  designCount: number;
  taskCount: number;
  active: boolean;
}

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  dependsOn: string[];
  agent: string;
  /** Upstream task ids that are not yet completed (drives the blocked DAG state). */
  blockedBy?: string[];
}

export interface GraphNodeUpdate {
  graphId: string;
  nodeId: string;
  status: string;
}

export interface GraphStartEvent {
  graphId: string;
  featureId: string;
  label: string;
  nodes: { id: string; label: string; dependsOn: string[]; parallelKey?: string; worktree?: string; branch?: string }[];
}

export interface GraphDoneEvent {
  graphId: string;
  status: string;
}

export interface GraphInspectorPayload {
  graphId: string;
  nodeId?: string;
  detail?: { nodes: GraphNodeSummary[]; approvals: GraphApprovalSummary[] };
  artifacts?: GraphArtifact[];
  metrics?: GraphMetrics | null;
  workingMemory?: WorkingMemorySnapshot | null;
  verification?: Array<{ nodeTitle?: string; passed?: boolean } & Record<string, unknown>>;
}

export type PipelineHostToWebview =
  | { type: "init"; settings: LiberideSettings; features: FeatureSummary[]; apiOrigin: string }
  | { type: "settings"; settings: LiberideSettings }
  | { type: "features"; features: FeatureSummary[]; activeFeature?: { id: string; tasks: TaskSummary[] } }
  | { type: "graphStart"; payload: GraphStartEvent }
  | { type: "graphNode"; payload: GraphNodeUpdate }
  | { type: "graphDone"; payload: GraphDoneEvent }
  | { type: "graphInspector"; payload: GraphInspectorPayload }
  | { type: "operation"; action: "scaffold" | "dispatch" | "cancel"; status: "running" | "success" | "error"; message?: string }
  | { type: "log"; message: string; severity?: "info" | "warning" | "error" };

export type PipelineWebviewToHost =
  | { type: "ready" }
  | { type: "setActiveFeature"; featureId: string }
  | { type: "scaffoldFeature"; name: string }
  | { type: "dispatchFeature"; featureId: string; taskIds?: string[] }
  | { type: "cancelGraph"; graphId: string }
  | { type: "inspectRun"; graphId: string; nodeId?: string }
  | { type: "refreshInspector"; graphId: string; nodeId?: string }
  | { type: "resolveApproval"; graphId: string; approvalId: string; status: "approved" | "rejected"; response?: string }
  | { type: "openArtifact"; graphId: string; artifactId: string }
  | { type: "openDiff"; path: string }
  | { type: "revertEditedFile"; path: string }
  | { type: "openTask"; featureId: string; taskId: string }
  | { type: "openChat" };
