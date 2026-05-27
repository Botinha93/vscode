/**
 * Lightweight syntax highlighter used by the chat timeline markdown renderer
 * and the VS Code chat webview. It returns sanitised HTML composed of
 * `<span class="tok-…">` wrappers that pick up colors from the active
 * Chatllm theme's `--syntax-*` CSS variables (see `styles.css`).
 *
 * This is intentionally compact — for full IDE-grade tokenisation the user
 * opens the Cloud IDE (which uses Monaco with the same palette). Markdown
 * code blocks are typically short snippets, so a regex pass with sane fall
 * backs is enough to deliver a Nord-style "good enough" highlight.
 *
 * Tokens fall back to `<span class="tok-foreground">` when no language is
 * known, ensuring code blocks always honour `--syntax-foreground`.
 */

type Token = { type: TokenType; value: string };
type TokenType =
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "type"
  | "function"
  | "operator"
  | "punctuation"
  | "regexp"
  | "escape"
  | "decorator"
  | "tag"
  | "attribute"
  | "property"
  | "constant"
  | "variable"
  | "foreground"
  | "error";

const KEYWORDS_JS = new Set([
  "abstract", "as", "async", "await", "break", "case", "catch", "class", "const", "continue",
  "debugger", "default", "delete", "do", "else", "enum", "export", "extends", "false", "finally",
  "for", "from", "function", "get", "if", "implements", "import", "in", "instanceof", "interface",
  "is", "let", "new", "null", "of", "package", "private", "protected", "public", "readonly",
  "return", "satisfies", "set", "static", "super", "switch", "this", "throw", "true", "try",
  "type", "typeof", "undefined", "var", "void", "while", "with", "yield",
]);

const KEYWORDS_PYTHON = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue",
  "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import",
  "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while",
  "with", "yield", "self",
]);

const KEYWORDS_RUST = new Set([
  "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum",
  "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move",
  "mut", "pub", "ref", "return", "Self", "self", "static", "struct", "super", "trait", "true",
  "type", "unsafe", "use", "where", "while",
]);

const KEYWORDS_GO = new Set([
  "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough",
  "for", "func", "go", "goto", "if", "import", "interface", "map", "package", "range",
  "return", "select", "struct", "switch", "type", "var",
]);

const KEYWORDS_SHELL = new Set([
  "if", "then", "else", "elif", "fi", "case", "esac", "for", "while", "until", "do", "done",
  "function", "return", "in", "select", "true", "false", "local", "export", "readonly", "set",
  "unset", "shift", "exec",
]);

const KEYWORDS_SQL = new Set([
  "SELECT", "FROM", "WHERE", "INSERT", "UPDATE", "DELETE", "INTO", "VALUES", "SET", "AS", "ON",
  "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "FULL", "GROUP", "BY", "ORDER", "HAVING", "LIMIT",
  "OFFSET", "CREATE", "TABLE", "INDEX", "DROP", "ALTER", "ADD", "PRIMARY", "KEY", "FOREIGN",
  "REFERENCES", "NOT", "NULL", "DEFAULT", "UNIQUE", "AND", "OR", "IN", "LIKE", "IS", "BETWEEN",
  "WITH", "DISTINCT", "UNION", "ALL", "CASE", "WHEN", "THEN", "ELSE", "END", "RETURNING",
]);

const PYTHON_BUILTIN_TYPES = new Set([
  "int", "str", "bool", "float", "list", "dict", "tuple", "set", "bytes", "object", "type",
]);

const RUST_BUILTIN_TYPES = new Set([
  "bool", "char", "str", "String", "i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16",
  "u32", "u64", "u128", "usize", "f32", "f64", "Vec", "Option", "Result", "Box", "Rc", "Arc",
]);

const GO_BUILTIN_TYPES = new Set([
  "bool", "string", "int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16",
  "uint32", "uint64", "byte", "rune", "float32", "float64", "complex64", "complex128", "error",
  "any",
]);

type LanguageId =
  | "js"
  | "ts"
  | "python"
  | "rust"
  | "go"
  | "shell"
  | "sql"
  | "json"
  | "css"
  | "html"
  | "xml"
  | "yaml"
  | "markdown"
  | "diff"
  | "plain";

export function normaliseHighlightLanguage(language: string | undefined | null): LanguageId {
  if (!language) return "plain";
  const lower = language.toLowerCase();
  switch (lower) {
    case "js":
    case "javascript":
    case "jsx":
    case "mjs":
    case "cjs":
      return "js";
    case "ts":
    case "typescript":
    case "tsx":
      return "ts";
    case "py":
    case "python":
      return "python";
    case "rs":
    case "rust":
      return "rust";
    case "go":
    case "golang":
      return "go";
    case "sh":
    case "bash":
    case "zsh":
    case "shell":
    case "console":
      return "shell";
    case "sql":
      return "sql";
    case "json":
    case "jsonc":
      return "json";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "html":
    case "htm":
    case "vue":
    case "svelte":
      return "html";
    case "xml":
    case "svg":
      return "xml";
    case "yml":
    case "yaml":
      return "yaml";
    case "md":
    case "markdown":
    case "mdx":
      return "markdown";
    case "diff":
    case "patch":
      return "diff";
    default:
      return "plain";
  }
}

/**
 * Highlight a code snippet and return safe HTML. The output is composed of
 * `<span class="tok-…">` elements only, with the original text already
 * HTML-escaped, so callers can drop it into `innerHTML` directly.
 */
export function highlightCode(code: string, language: string | undefined | null): string {
  const lang = normaliseHighlightLanguage(language);
  if (lang === "plain") return escapeHtml(code);
  if (lang === "diff") return highlightDiff(code);
  const tokens = tokenize(code, lang);
  return tokens.map(renderToken).join("");
}

function renderToken(token: Token): string {
  const cls = `tok-${token.type}`;
  return `<span class="${cls}">${escapeHtml(token.value)}</span>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return c;
    }
  });
}

function highlightDiff(code: string): string {
  return code.split(/(\r?\n)/).map((line) => {
    if (/^\r?\n$/.test(line)) return line;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      return `<span class="tok-string">${escapeHtml(line)}</span>`;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      return `<span class="tok-error">${escapeHtml(line)}</span>`;
    }
    if (line.startsWith("@@")) {
      return `<span class="tok-decorator">${escapeHtml(line)}</span>`;
    }
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ")) {
      return `<span class="tok-comment">${escapeHtml(line)}</span>`;
    }
    return escapeHtml(line);
  }).join("");
}

function tokenize(code: string, lang: LanguageId): Token[] {
  switch (lang) {
    case "js":
    case "ts":
      return tokenizeC(code, lang);
    case "python":
      return tokenizePython(code);
    case "rust":
      return tokenizeRust(code);
    case "go":
      return tokenizeGo(code);
    case "shell":
      return tokenizeShell(code);
    case "sql":
      return tokenizeSql(code);
    case "json":
      return tokenizeJson(code);
    case "css":
      return tokenizeCss(code);
    case "html":
    case "xml":
      return tokenizeMarkup(code);
    case "yaml":
      return tokenizeYaml(code);
    case "markdown":
      return tokenizeMarkdown(code);
    case "plain":
    case "diff":
    default:
      return [{ type: "foreground", value: code }];
  }
}

interface MatchSpec {
  re: RegExp;
  /** Token type for the full match, or a function returning a per-capture type. */
  type: TokenType | ((m: RegExpExecArray) => TokenType);
}

/**
 * Runs a list of regex specs against `code` and returns tokens in source
 * order. Specs are tried in array order at each position; the first one
 * matching at the current cursor wins. Unmatched characters fall through
 * as `foreground` tokens so nothing is dropped.
 */
function scan(code: string, specs: MatchSpec[]): Token[] {
  const out: Token[] = [];
  let i = 0;
  let pending = "";
  const flushPending = () => {
    if (pending) {
      out.push({ type: "foreground", value: pending });
      pending = "";
    }
  };
  while (i < code.length) {
    let matched: { match: RegExpExecArray; type: TokenType } | null = null;
    for (const spec of specs) {
      spec.re.lastIndex = i;
      const m = spec.re.exec(code);
      if (m && m.index === i) {
        const t = typeof spec.type === "function" ? spec.type(m) : spec.type;
        matched = { match: m, type: t };
        break;
      }
    }
    if (matched) {
      flushPending();
      out.push({ type: matched.type, value: matched.match[0] });
      i += matched.match[0].length;
    } else {
      pending += code[i];
      i += 1;
    }
  }
  flushPending();
  return out;
}

function tokenizeC(code: string, lang: "js" | "ts"): Token[] {
  const keywords = KEYWORDS_JS;
  const specs: MatchSpec[] = [
    { re: /\/\/[^\n]*/y, type: "comment" },
    { re: /\/\*[\s\S]*?\*\//y, type: "comment" },
    { re: /`(?:\\[\s\S]|\$\{[^}]*\}|[^`\\])*`/y, type: "string" },
    { re: /"(?:\\[\s\S]|[^"\\])*"/y, type: "string" },
    { re: /'(?:\\[\s\S]|[^'\\])*'/y, type: "string" },
    { re: /\/(?:\\[\s\S]|\[(?:\\[\s\S]|[^\]\\])*\]|[^/\\\n])+\/[gimsuy]*(?=\s|\.|\)|,|;|$)/y, type: "regexp" },
    { re: /\b(?:0x[\da-fA-F]+|0b[01]+|0o[0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/y, type: "number" },
    { re: /(?:@[A-Za-z_$][\w$]*)/y, type: "decorator" },
    {
      re: /\b[A-Za-z_$][\w$]*\b/y,
      type: (m) => {
        const word = m[0];
        if (keywords.has(word)) return "keyword";
        if (lang === "ts" && /^[A-Z]/.test(word)) return "type";
        if (lang === "js" && /^[A-Z][A-Z0-9_]*$/.test(word)) return "constant";
        const after = code.slice(m.index + word.length);
        if (after.startsWith("(")) return "function";
        return "variable";
      },
    },
    { re: /[+\-*/%&|^!=<>?:]+/y, type: "operator" },
    { re: /[{}()[\];,.]/y, type: "punctuation" },
  ];
  return scan(code, specs);
}

function tokenizePython(code: string): Token[] {
  const specs: MatchSpec[] = [
    { re: /#[^\n]*/y, type: "comment" },
    { re: /[rRbBuUfF]{0,2}"""[\s\S]*?"""/y, type: "string" },
    { re: /[rRbBuUfF]{0,2}'''[\s\S]*?'''/y, type: "string" },
    { re: /[rRbBuUfF]{0,2}"(?:\\[\s\S]|[^"\\])*"/y, type: "string" },
    { re: /[rRbBuUfF]{0,2}'(?:\\[\s\S]|[^'\\])*'/y, type: "string" },
    { re: /\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?j?)\b/y, type: "number" },
    { re: /@[A-Za-z_][\w]*/y, type: "decorator" },
    {
      re: /\b[A-Za-z_][\w]*\b/y,
      type: (m) => {
        const word = m[0];
        if (KEYWORDS_PYTHON.has(word)) return "keyword";
        if (PYTHON_BUILTIN_TYPES.has(word)) return "type";
        const after = code.slice(m.index + word.length);
        if (after.startsWith("(")) return "function";
        return "variable";
      },
    },
    { re: /[+\-*/%&|^!=<>]+/y, type: "operator" },
    { re: /[{}()[\]:,.;]/y, type: "punctuation" },
  ];
  return scan(code, specs);
}

function tokenizeRust(code: string): Token[] {
  const specs: MatchSpec[] = [
    { re: /\/\/[^\n]*/y, type: "comment" },
    { re: /\/\*[\s\S]*?\*\//y, type: "comment" },
    { re: /b?"(?:\\[\s\S]|[^"\\])*"/y, type: "string" },
    { re: /b?'(?:\\[\s\S]|[^'\\])'/y, type: "string" },
    { re: /\b(?:0x[\da-fA-F_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?(?:[ui](?:8|16|32|64|128|size)|f(?:32|64))?)\b/y, type: "number" },
    { re: /#!?\[[^\]]*\]/y, type: "decorator" },
    { re: /'[A-Za-z_]\w*\b/y, type: "decorator" },
    {
      re: /\b[A-Za-z_][\w]*!?/y,
      type: (m) => {
        const word = m[0];
        if (word.endsWith("!")) return "function";
        if (KEYWORDS_RUST.has(word)) return "keyword";
        if (RUST_BUILTIN_TYPES.has(word)) return "type";
        if (/^[A-Z]/.test(word)) return "type";
        const after = code.slice(m.index + word.length);
        if (after.startsWith("(")) return "function";
        return "variable";
      },
    },
    { re: /->|=>|::|[+\-*/%&|^!=<>?]+/y, type: "operator" },
    { re: /[{}()[\];,.]/y, type: "punctuation" },
  ];
  return scan(code, specs);
}

function tokenizeGo(code: string): Token[] {
  const specs: MatchSpec[] = [
    { re: /\/\/[^\n]*/y, type: "comment" },
    { re: /\/\*[\s\S]*?\*\//y, type: "comment" },
    { re: /`[^`]*`/y, type: "string" },
    { re: /"(?:\\[\s\S]|[^"\\])*"/y, type: "string" },
    { re: /'(?:\\[\s\S]|[^'\\])'/y, type: "string" },
    { re: /\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?i?)\b/y, type: "number" },
    {
      re: /\b[A-Za-z_][\w]*\b/y,
      type: (m) => {
        const word = m[0];
        if (KEYWORDS_GO.has(word)) return "keyword";
        if (GO_BUILTIN_TYPES.has(word)) return "type";
        const after = code.slice(m.index + word.length);
        if (after.startsWith("(")) return "function";
        if (/^[A-Z]/.test(word)) return "type";
        return "variable";
      },
    },
    { re: /:=|<-|[+\-*/%&|^!=<>]+/y, type: "operator" },
    { re: /[{}()[\];,.]/y, type: "punctuation" },
  ];
  return scan(code, specs);
}

function tokenizeShell(code: string): Token[] {
  const specs: MatchSpec[] = [
    { re: /#[^\n]*/y, type: "comment" },
    { re: /"(?:\\[\s\S]|\$\{[^}]*\}|\$[A-Za-z_][\w]*|[^"\\$])*"/y, type: "string" },
    { re: /'[^']*'/y, type: "string" },
    { re: /\$\{[^}]+\}/y, type: "variable" },
    { re: /\$[A-Za-z_][\w]*/y, type: "variable" },
    { re: /\$\d+/y, type: "variable" },
    { re: /\b\d+\b/y, type: "number" },
    {
      re: /\b[A-Za-z_][\w-]*/y,
      type: (m) => (KEYWORDS_SHELL.has(m[0]) ? "keyword" : "variable"),
    },
    { re: /--?[A-Za-z][\w-]*/y, type: "decorator" },
    { re: /\|\||&&|>>|<<|[|&;<>()]/y, type: "operator" },
  ];
  return scan(code, specs);
}

function tokenizeSql(code: string): Token[] {
  const specs: MatchSpec[] = [
    { re: /--[^\n]*/y, type: "comment" },
    { re: /\/\*[\s\S]*?\*\//y, type: "comment" },
    { re: /'(?:''|[^'])*'/y, type: "string" },
    { re: /"(?:""|[^"])*"/y, type: "string" },
    { re: /\b\d+(?:\.\d+)?\b/y, type: "number" },
    {
      re: /\b[A-Za-z_][\w]*\b/y,
      type: (m) => (KEYWORDS_SQL.has(m[0].toUpperCase()) ? "keyword" : "variable"),
    },
    { re: /[+\-*/%=<>!]+/y, type: "operator" },
    { re: /[(),;.]/y, type: "punctuation" },
  ];
  return scan(code, specs);
}

function tokenizeJson(code: string): Token[] {
  const specs: MatchSpec[] = [
    { re: /\/\/[^\n]*/y, type: "comment" }, // tolerate jsonc
    { re: /\/\*[\s\S]*?\*\//y, type: "comment" },
    {
      re: /"(?:\\[\s\S]|[^"\\])*"(?=\s*:)/y,
      type: "property",
    },
    { re: /"(?:\\[\s\S]|[^"\\])*"/y, type: "string" },
    { re: /\b(?:true|false|null)\b/y, type: "constant" },
    { re: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y, type: "number" },
    { re: /[{}[\]:,]/y, type: "punctuation" },
  ];
  return scan(code, specs);
}

function tokenizeCss(code: string): Token[] {
  const specs: MatchSpec[] = [
    { re: /\/\*[\s\S]*?\*\//y, type: "comment" },
    { re: /"(?:\\[\s\S]|[^"\\])*"/y, type: "string" },
    { re: /'(?:\\[\s\S]|[^'\\])*'/y, type: "string" },
    { re: /@[A-Za-z-]+/y, type: "decorator" },
    { re: /#[\da-fA-F]{3,8}\b/y, type: "constant" },
    { re: /-?\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|deg|s|ms)?/y, type: "number" },
    { re: /--[A-Za-z_-][\w-]*/y, type: "variable" },
    { re: /[A-Za-z-]+(?=\s*:)/y, type: "property" },
    { re: /[.#&][A-Za-z_][\w-]*/y, type: "attribute" },
    { re: /[{}();,:]/y, type: "punctuation" },
  ];
  return scan(code, specs);
}

function tokenizeMarkup(code: string): Token[] {
  const specs: MatchSpec[] = [
    { re: /<!--[\s\S]*?-->/y, type: "comment" },
    { re: /<!\[CDATA\[[\s\S]*?\]\]>/y, type: "comment" },
    { re: /<!DOCTYPE[^>]+>/y, type: "decorator" },
    { re: /"(?:[^"\\]|\\[\s\S])*"/y, type: "string" },
    { re: /'(?:[^'\\]|\\[\s\S])*'/y, type: "string" },
    { re: /<\/?[A-Za-z][\w-]*/y, type: "tag" },
    { re: /\/?>/y, type: "tag" },
    { re: /[A-Za-z_:][\w-]*(?==)/y, type: "attribute" },
    { re: /=/y, type: "operator" },
    { re: /&[#\w]+;/y, type: "escape" },
  ];
  return scan(code, specs);
}

function tokenizeYaml(code: string): Token[] {
  const specs: MatchSpec[] = [
    { re: /#[^\n]*/y, type: "comment" },
    { re: /"(?:\\[\s\S]|[^"\\])*"/y, type: "string" },
    { re: /'[^']*'/y, type: "string" },
    { re: /^---$/my, type: "decorator" },
    { re: /^[ \t]*-\s/my, type: "punctuation" },
    { re: /^\s*[A-Za-z_][\w-]*(?=\s*:)/my, type: "property" },
    { re: /\b(?:true|false|null|yes|no|on|off)\b/y, type: "constant" },
    { re: /-?\b\d+(?:\.\d+)?\b/y, type: "number" },
    { re: /[&*][A-Za-z_][\w-]*/y, type: "decorator" },
    { re: /[{}[\],:]/y, type: "punctuation" },
  ];
  return scan(code, specs);
}

function tokenizeMarkdown(code: string): Token[] {
  const specs: MatchSpec[] = [
    { re: /^#{1,6}\s.+/my, type: "keyword" },
    { re: /^>\s.+/my, type: "comment" },
    { re: /^[*+-]\s/my, type: "punctuation" },
    { re: /`[^`]+`/y, type: "string" },
    { re: /\*\*[^*]+\*\*/y, type: "keyword" },
    { re: /_[^_]+_/y, type: "type" },
    { re: /\[[^\]]+\]\([^)]+\)/y, type: "decorator" },
    { re: /https?:\/\/\S+/y, type: "decorator" },
  ];
  return scan(code, specs);
}
