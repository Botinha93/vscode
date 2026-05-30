import type { LiberideSettings } from "../settings";

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
  nodes: { id: string; label: string; dependsOn: string[] }[];
}

export interface GraphDoneEvent {
  graphId: string;
  status: string;
}

export type PipelineHostToWebview =
  | { type: "init"; settings: LiberideSettings; features: FeatureSummary[]; apiOrigin: string }
  | { type: "settings"; settings: LiberideSettings }
  | { type: "features"; features: FeatureSummary[]; activeFeature?: { id: string; tasks: TaskSummary[] } }
  | { type: "graphStart"; payload: GraphStartEvent }
  | { type: "graphNode"; payload: GraphNodeUpdate }
  | { type: "graphDone"; payload: GraphDoneEvent }
  | { type: "operation"; action: "scaffold" | "dispatch" | "cancel"; status: "running" | "success" | "error"; message?: string }
  | { type: "log"; message: string; severity?: "info" | "warning" | "error" };

export type PipelineWebviewToHost =
  | { type: "ready" }
  | { type: "setActiveFeature"; featureId: string }
  | { type: "scaffoldFeature"; name: string }
  | { type: "dispatchFeature"; featureId: string; taskIds?: string[] }
  | { type: "cancelGraph"; graphId: string }
  | { type: "openTask"; featureId: string; taskId: string }
  | { type: "openChat" };
