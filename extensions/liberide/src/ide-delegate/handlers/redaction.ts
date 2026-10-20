import * as path from "node:path";

/**
 * Secret-file redaction for every delegate result that carries file content
 * (search matches, git diffs, dirty buffers, the active selection). Mirrors
 * the server's `isSecretFile` / `redactSecretFile` used for ide_read_file
 * (apps/api/src/services/ide/ide-tools.ts); keep the two in sync.
 */

/** Files that exist to hold secrets: their contents are fully redacted. */
const SECRET_FILE_NAME = /^(\.env(\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|id_(rsa|dsa|ecdsa|ed25519)|.*\.(pem|key|p12|pfx|keystore|jks))$/i;

export function isSecretFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return SECRET_FILE_NAME.test(base) && !/\.(example|sample|template|dist)$/i.test(base);
}

const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /((?:api[_-]?key|token|secret|password|passwd|pwd|credential))[=:][ ]*[\x27\x22]?([\w\-/=]+)[\x27\x22]?/gi, replacement: "$1=[REDACTED]" },
  { pattern: /x-api-key[=:][ ]*[\x27\x22]?([^\s,\x27\x22]+)[\x27\x22]?/gi, replacement: "x-api-key=[REDACTED]" },
  { pattern: /"(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|secret|private[_-]?key)"\s*:\s*"[^"]+"/gi, replacement: "\"[REDACTED]\":\"[REDACTED]\"" },
  { pattern: /Bearer[ ]+([\w.-]+)/gi, replacement: "Bearer [REDACTED]" },
  { pattern: /Basic[ ]+([\w+/=]+)/gi, replacement: "Basic [REDACTED]" },
  { pattern: /(?:https?|git):\/\/[^:]+:[^@]+@/gi, replacement: "https://[REDACTED]@" },
  { pattern: /(-----BEGIN[ ]+(?:RSA|DSA|EC|OPENSSH)[ ]+PRIVATE[ ]+KEY-----)[\s\S]*?(-----END[ ]+(?:RSA|DSA|EC|OPENSSH)[ ]+PRIVATE[ ]+KEY-----)/gi, replacement: "$1 [REDACTED] $2" },
  { pattern: /((?:aws_access_key_id|aws_secret_access_key))[=:][ ]*[\x27\x22]?([\w/+ =]+)[\x27\x22]?/gi, replacement: "$1=[REDACTED]" },
  { pattern: /(postgresql|mysql|mongodb|redis):\/\/([^:]+):([^@]+)@/gi, replacement: "$1://$2:[REDACTED]@" },
];

/** Base64 key material on its own line (a matched line of a pem/key file). */
const KEY_MATERIAL = /^[A-Za-z0-9+/=]{16,}$/;

/** Full redaction for a secret file: every `key=value` value, plus the generic patterns. */
export function redactSecretFile(filePath: string, text: string): string {
  const base = path.basename(filePath).toLowerCase();
  let values = base.startsWith(".env") || base.endsWith(".npmrc") || base.endsWith(".pypirc")
    ? text.replace(/^(\s*(?:export\s+)?[\w.-]+\s*[=:]\s*)(\S.*)$/gm, "$1[REDACTED]")
    : text;
  // A search match or diff line is one line of a key file: the BEGIN/END
  // pattern below never sees both ends, so drop key material line by line.
  if (/\.(pem|key|p12|pfx|keystore|jks)$/.test(base) || /^id_/.test(base)) {
    values = values.split("\n").map((line) => (KEY_MATERIAL.test(line.trim()) ? "[REDACTED]" : line)).join("\n");
  }
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) values = values.replace(pattern, replacement);
  return values;
}

/** Redact `text` when it comes from a secret file; other files pass through. */
export function redactIfSecret(filePath: string, text: string): { text: string; redacted: boolean } {
  if (!isSecretFile(filePath)) return { text, redacted: false };
  return { text: redactSecretFile(filePath, text), redacted: true };
}

/**
 * Redact the hunks of secret files in a unified diff (`git diff` output).
 * Headers stay so the caller still sees which files changed.
 */
export function redactUnifiedDiff(diff: string, filePath?: string): string {
  // A single-file diff may come without a `diff --git` header.
  let secretPath: string | undefined = filePath && isSecretFile(filePath) ? filePath : undefined;
  return diff.split("\n").map((line) => {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      secretPath = isSecretFile(header[2]!) || isSecretFile(header[1]!) ? header[2]! : undefined;
      return line;
    }
    if (!secretPath) return line;
    if (/^(---|\+\+\+|@@|index |new file|deleted file|similarity|rename |old mode|new mode|Binary)/.test(line)) return line;
    const prefix = line.slice(0, 1);
    if (prefix !== "+" && prefix !== "-" && prefix !== " ") return line;
    return prefix + redactSecretFile(secretPath, line.slice(1));
  }).join("\n");
}

export function countRedactionPlaceholders(text: string): number {
  return text.split("[REDACTED]").length - 1;
}

/** A write must not persist `[REDACTED]` placeholders that came from a redacted read. */
export function assertNoRedactionPlaceholders(before: string, after: string, filePath: string): void {
  if (countRedactionPlaceholders(after) > countRedactionPlaceholders(before)) {
    throw new Error(`Refusing to write '${filePath}': the new content contains [REDACTED] placeholders from a redacted read. Edit only the lines you need instead of rewriting redacted values.`);
  }
}
