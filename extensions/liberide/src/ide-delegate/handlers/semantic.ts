import * as vscode from "vscode";
import { resolveFileUri } from "./helpers";

export async function handleSemanticTokens(payload: Record<string, unknown>): Promise<unknown> {
  const uri = resolveFileUri(String(payload.path ?? ""));
  const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>(
    "vscode.provideDocumentSemanticTokens",
    uri
  );
  if (!tokens) return { path: String(payload.path ?? ""), available: false };
  return {
    path: String(payload.path ?? ""),
    data: tokens.data,
    resultId: tokens.resultId,
    length: tokens.data.length,
  };
}
