import * as vscode from "vscode";
import { isInWorkspace, relativePath, resolveFileUri } from "./helpers";

function locationToJson(loc: vscode.Location | vscode.LocationLink): Record<string, unknown> {
  if ("uri" in loc && loc.uri) {
    return {
      path: relativePath(loc.uri.fsPath),
      line: loc.range.start.line + 1,
      character: loc.range.start.character,
    };
  }
  const link = loc as vscode.LocationLink;
  return {
    path: relativePath(link.targetUri.fsPath),
    line: link.targetRange.start.line + 1,
    character: link.targetRange.start.character,
  };
}

/** One page of `items`: `offset`/`cursor` (0-based) and `maxResults`, with `nextCursor` when more remain. */
export function pageOf<T>(items: T[], payload: Record<string, unknown>, defaultSize = 50): { page: T[]; offset: number; total: number; nextCursor?: number } {
  const size = Math.max(1, Math.min(Math.floor(Number(payload.maxResults ?? defaultSize)) || defaultSize, 500));
  const offset = Math.max(0, Math.floor(Number(payload.offset ?? payload.cursor ?? 0)) || 0);
  const page = items.slice(offset, offset + size);
  const end = offset + page.length;
  return { page, offset, total: items.length, ...(end < items.length ? { nextCursor: end } : {}) };
}

export async function handleWorkspaceSymbols(payload: Record<string, unknown>): Promise<unknown> {
  const query = String(payload.query ?? "");
  const all = (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
    "vscode.executeWorkspaceSymbolProvider",
    query
  )) ?? [];
  // Only this folder's symbols (providers may return library/other-root ones).
  const symbols = all.filter((s) => s.location.uri.scheme !== "file" || isInWorkspace(s.location.uri.fsPath));
  const { page, offset, total, nextCursor } = pageOf(symbols, payload);
  return {
    offset,
    total,
    ...(nextCursor !== undefined ? { nextCursor, hasMore: true } : { hasMore: false }),
    symbols: page.map((s) => ({
      name: s.name,
      kind: vscode.SymbolKind[s.kind],
      path: relativePath(s.location.uri.fsPath),
      line: s.location.range.start.line + 1,
      character: s.location.range.start.character,
      containerName: s.containerName,
    })),
  };
}

export async function handleDocumentSymbols(payload: Record<string, unknown>): Promise<unknown> {
  const filePath = String(payload.path ?? "");
  const uri = resolveFileUri(filePath);
  const symbols = (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    "vscode.executeDocumentSymbolProvider",
    uri
  )) ?? [];
  const flatten = (items: vscode.DocumentSymbol[], out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> => {
    for (const item of items) {
      out.push({
        name: item.name,
        kind: vscode.SymbolKind[item.kind],
        line: item.range.start.line + 1,
        detail: item.detail,
      });
      if (item.children?.length) flatten(item.children, out);
    }
    return out;
  };
  return { path: filePath, symbols: flatten(symbols) };
}

export async function handleDefinition(payload: Record<string, unknown>): Promise<unknown> {
  const uri = resolveFileUri(String(payload.path ?? ""));
  const position = new vscode.Position(Number(payload.line ?? 1) - 1, Number(payload.character ?? 0));
  const defs = (await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
    "vscode.executeDefinitionProvider",
    uri,
    position
  )) ?? [];
  return { definitions: defs.map(locationToJson) };
}

export async function handleReferences(payload: Record<string, unknown>): Promise<unknown> {
  const uri = resolveFileUri(String(payload.path ?? ""));
  const position = new vscode.Position(Number(payload.line ?? 1) - 1, Number(payload.character ?? 0));
  const refs = (await vscode.commands.executeCommand<vscode.Location[]>(
    "vscode.executeReferenceProvider",
    uri,
    position
  )) ?? [];
  const maxResults = Number(payload.maxResults ?? 50);
  return { references: refs.slice(0, maxResults).map(locationToJson) };
}

export async function handleHover(payload: Record<string, unknown>): Promise<unknown> {
  const uri = resolveFileUri(String(payload.path ?? ""));
  const position = new vscode.Position(Number(payload.line ?? 1) - 1, Number(payload.character ?? 0));
  const hover = await vscode.commands.executeCommand<vscode.Hover[]>(
    "vscode.executeHoverProvider",
    uri,
    position
  );
  const first = Array.isArray(hover) ? hover[0] : hover;
  const text = first?.contents
    ?.map((c) => (typeof c === "string" ? c : "value" in c ? c.value : ""))
    .join("\n");
  return { hover: text ?? null };
}
