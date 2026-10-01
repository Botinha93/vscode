import * as vscode from "vscode";
import { workspaceFolder } from "./helpers";

/**
 * Workspace-scoped targets only: user (global) settings apply to every
 * project and include security switches such as workspace trust.
 */
const TARGET_MAP: Record<string, vscode.ConfigurationTarget> = {
  workspace: vscode.ConfigurationTarget.Workspace,
  workspaceFolder: vscode.ConfigurationTarget.WorkspaceFolder,
};

/**
 * Settings the agent may read and change: editor/formatting behaviour only.
 * An allowlist, because many settings run code (interpreter, tsdk, eslint
 * node path, terminal profiles, tasks, launch configs) and new ones appear
 * with every extension.
 */
const ALLOWED_KEYS: RegExp[] = [
  /^editor\.[\w.]+$/,
  /^diffEditor\.[\w.]+$/,
  /^files\.(exclude|associations|watcherExclude|readonlyInclude|readonlyExclude|insertFinalNewline|trimFinalNewlines|trimTrailingWhitespace|eol|encoding|autoGuessEncoding|autoSave|autoSaveDelay)$/,
  /^search\.(exclude|useIgnoreFiles|useParentIgnoreFiles|smartCase)$/,
  /^(typescript|javascript)\.format\.\w+$/,
  /^(typescript|javascript)\.preferences\.(quoteStyle|importModuleSpecifier|importModuleSpecifierEnding|jsxAttributeCompletionStyle)$/,
  /^prettier\.(semi|singleQuote|jsxSingleQuote|tabWidth|useTabs|printWidth|trailingComma|bracketSpacing|bracketSameLine|arrowParens|endOfLine|quoteProps|proseWrap|singleAttributePerLine|requireConfig)$/,
  /^html\.format\.\w+$/,
  /^(css|scss|less)\.format\.\w+$/,
  /^json\.format\.\w+$/,
];

/** Even inside an allowed section, nothing that names a program, path, command or environment. */
const DENIED_KEY = /(path|paths|executable|interpreter|command|commands|args|env|shell|server|tsdk|nodePath|runtime|url)$/i;

/** `[lang].editor.tabSize` style keys: a language override of an allowed key. */
const LANGUAGE_OVERRIDE = /^\[([\w\-+#. ]+)\]\.(.+)$/;

/** Whether the agent may read/change `fullKey` (`section.key`, optionally `[lang].`-prefixed). */
export function isAgentConfigurableKey(fullKey: string): boolean {
  const override = LANGUAGE_OVERRIDE.exec(fullKey);
  const key = override ? override[2]! : fullKey;
  if (!key || key.includes("[") || DENIED_KEY.test(key)) return false;
  return ALLOWED_KEYS.some((re) => re.test(key));
}

function fullKeyOf(payload: Record<string, unknown>): string {
  const section = String(payload.section ?? "").trim();
  const key = String(payload.key ?? "").trim();
  return section && key ? `${section}.${key}` : section || key;
}

/** Configuration scoped to the request's folder (and language, for `[lang].` keys). */
function scopedConfig(fullKey: string): { config: vscode.WorkspaceConfiguration; key: string; languageId?: string } {
  const folder = workspaceFolder();
  const override = LANGUAGE_OVERRIDE.exec(fullKey);
  const languageId = override?.[1];
  const key = override ? override[2]! : fullKey;
  const scope = languageId ? { uri: folder?.uri, languageId } : folder?.uri;
  return { config: vscode.workspace.getConfiguration(undefined, scope), key, languageId };
}

/** Only workspace-level values: user (global) settings can hold credentials and are not the project's. */
function workspaceValues(config: vscode.WorkspaceConfiguration, key: string, languageId?: string): Record<string, unknown> {
  const inspected = config.inspect(key);
  const workspaceValue = languageId ? inspected?.workspaceLanguageValue : inspected?.workspaceValue;
  const workspaceFolderValue = languageId ? inspected?.workspaceFolderLanguageValue : inspected?.workspaceFolderValue;
  return {
    value: workspaceFolderValue ?? workspaceValue ?? (languageId ? inspected?.defaultLanguageValue : undefined) ?? inspected?.defaultValue,
    defaultValue: languageId ? inspected?.defaultLanguageValue ?? inspected?.defaultValue : inspected?.defaultValue,
    workspaceValue,
    workspaceFolderValue,
  };
}

/** Leaf keys under `section` in the merged configuration (bounded). */
function leafKeys(value: unknown, prefix: string, out: string[] = []): string[] {
  if (out.length >= 300) return out;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
      const key = `${prefix}.${name}`;
      // Map-valued settings (files.exclude) are one setting, not a section.
      if (isAgentConfigurableKey(key)) out.push(key);
      else leafKeys(child, key, out);
    }
  }
  return out;
}

export async function handleConfigRead(payload: Record<string, unknown>): Promise<unknown> {
  const section = String(payload.section ?? "");
  const key = payload.key ? String(payload.key) : undefined;
  if (!section && !key) throw new Error("section or key is required; reading every setting is not supported");
  const fullKey = fullKeyOf(payload);
  if (key || isAgentConfigurableKey(fullKey)) {
    if (!isAgentConfigurableKey(fullKey)) throw new Error(`Setting '${fullKey}' is not readable by the agent (only editor and formatting settings are)`);
    const scoped = scopedConfig(fullKey);
    return { section, key: key ?? "", ...workspaceValues(scoped.config, scoped.key, scoped.languageId) };
  }
  const override = /^\[([^\]]+)\]\.?(.*)$/.exec(section);
  const languageId = override?.[1];
  const base = override ? override[2]! : section;
  if (!base) throw new Error(`Pass a section inside the language override, e.g. '${section}.editor'`);
  const folder = workspaceFolder();
  const config = vscode.workspace.getConfiguration(undefined, languageId ? { uri: folder?.uri, languageId } : folder?.uri);
  const keys = leafKeys(config.get(base), base);
  if (!keys.length) throw new Error(`Section '${section}' has no settings the agent may read (only editor and formatting settings)`);
  const values: Record<string, unknown> = {};
  for (const leaf of keys) {
    const { workspaceValue, workspaceFolderValue, value } = workspaceValues(config, leaf, languageId);
    values[leaf.slice(base.length + 1)] = { value, ...(workspaceValue !== undefined ? { workspaceValue } : {}), ...(workspaceFolderValue !== undefined ? { workspaceFolderValue } : {}) };
  }
  return { section, values };
}

export async function handleConfigWrite(payload: Record<string, unknown>): Promise<unknown> {
  const section = String(payload.section ?? "");
  const key = String(payload.key ?? "");
  const value = payload.value;
  const targetName = String(payload.target ?? "workspace");
  const target = TARGET_MAP[targetName];
  if (target === undefined) throw new Error(`Setting target '${targetName}' is not allowed; use 'workspace' or 'workspaceFolder'`);
  const fullKey = fullKeyOf(payload);
  if (!key || !isAgentConfigurableKey(fullKey)) {
    throw new Error(`Setting '${fullKey}' cannot be changed by the agent (only editor and formatting settings can)`);
  }
  const scoped = scopedConfig(fullKey);
  await scoped.config.update(scoped.key, value, target, scoped.languageId ? true : undefined);
  return { section, key, target: targetName, updated: true };
}
