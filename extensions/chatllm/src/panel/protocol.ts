import type { ChatllmSettings } from "../settings";

export type Tab = "chat" | "pipeline" | "settings";

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

export type HostToWebview =
  | { type: "init"; settings: ChatllmSettings; features: FeatureSummary[]; activeTab: Tab; apiOrigin: string }
  | { type: "settings"; settings: ChatllmSettings }
  | { type: "tab"; tab: Tab }
  | { type: "features"; features: FeatureSummary[]; activeFeature?: { id: string; tasks: TaskSummary[] } }
  | { type: "chatToken"; token: string }
  | { type: "chatToolEvent"; name: string; arguments: Record<string, unknown> }
  | { type: "chatDone"; conversationId?: string }
  | { type: "chatError"; error: string }
  | { type: "graphStart"; payload: GraphStartEvent }
  | { type: "graphNode"; payload: GraphNodeUpdate }
  | { type: "graphDone"; payload: GraphDoneEvent }
  | { type: "log"; message: string };

export type WebviewToHost =
  | { type: "ready" }
  | { type: "switchTab"; tab: Tab }
  | { type: "sendChat"; content: string; command?: "spec" | "design" | "tasks" }
  | { type: "cancelChat" }
  | { type: "updateSetting"; key: keyof ChatllmSettings; value: unknown }
  | { type: "setActiveFeature"; featureId: string }
  | { type: "scaffoldFeature"; name: string }
  | { type: "dispatchFeature"; featureId: string; taskIds?: string[] }
  | { type: "cancelGraph"; graphId: string }
  | { type: "openTask"; featureId: string; taskId: string };
