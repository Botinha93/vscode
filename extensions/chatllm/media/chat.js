"use strict";
(() => {
  // src/webview/highlight.ts
  var KEYWORDS_JS = /* @__PURE__ */ new Set([
    "abstract",
    "as",
    "async",
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "export",
    "extends",
    "false",
    "finally",
    "for",
    "from",
    "function",
    "get",
    "if",
    "implements",
    "import",
    "in",
    "instanceof",
    "interface",
    "is",
    "let",
    "new",
    "null",
    "of",
    "package",
    "private",
    "protected",
    "public",
    "readonly",
    "return",
    "satisfies",
    "set",
    "static",
    "super",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "type",
    "typeof",
    "undefined",
    "var",
    "void",
    "while",
    "with",
    "yield"
  ]);
  var KEYWORDS_PYTHON = /* @__PURE__ */ new Set([
    "False",
    "None",
    "True",
    "and",
    "as",
    "assert",
    "async",
    "await",
    "break",
    "class",
    "continue",
    "def",
    "del",
    "elif",
    "else",
    "except",
    "finally",
    "for",
    "from",
    "global",
    "if",
    "import",
    "in",
    "is",
    "lambda",
    "nonlocal",
    "not",
    "or",
    "pass",
    "raise",
    "return",
    "try",
    "while",
    "with",
    "yield",
    "self"
  ]);
  var KEYWORDS_RUST = /* @__PURE__ */ new Set([
    "as",
    "async",
    "await",
    "break",
    "const",
    "continue",
    "crate",
    "dyn",
    "else",
    "enum",
    "extern",
    "false",
    "fn",
    "for",
    "if",
    "impl",
    "in",
    "let",
    "loop",
    "match",
    "mod",
    "move",
    "mut",
    "pub",
    "ref",
    "return",
    "Self",
    "self",
    "static",
    "struct",
    "super",
    "trait",
    "true",
    "type",
    "unsafe",
    "use",
    "where",
    "while"
  ]);
  var KEYWORDS_GO = /* @__PURE__ */ new Set([
    "break",
    "case",
    "chan",
    "const",
    "continue",
    "default",
    "defer",
    "else",
    "fallthrough",
    "for",
    "func",
    "go",
    "goto",
    "if",
    "import",
    "interface",
    "map",
    "package",
    "range",
    "return",
    "select",
    "struct",
    "switch",
    "type",
    "var"
  ]);
  var KEYWORDS_SHELL = /* @__PURE__ */ new Set([
    "if",
    "then",
    "else",
    "elif",
    "fi",
    "case",
    "esac",
    "for",
    "while",
    "until",
    "do",
    "done",
    "function",
    "return",
    "in",
    "select",
    "true",
    "false",
    "local",
    "export",
    "readonly",
    "set",
    "unset",
    "shift",
    "exec"
  ]);
  var KEYWORDS_SQL = /* @__PURE__ */ new Set([
    "SELECT",
    "FROM",
    "WHERE",
    "INSERT",
    "UPDATE",
    "DELETE",
    "INTO",
    "VALUES",
    "SET",
    "AS",
    "ON",
    "JOIN",
    "LEFT",
    "RIGHT",
    "INNER",
    "OUTER",
    "FULL",
    "GROUP",
    "BY",
    "ORDER",
    "HAVING",
    "LIMIT",
    "OFFSET",
    "CREATE",
    "TABLE",
    "INDEX",
    "DROP",
    "ALTER",
    "ADD",
    "PRIMARY",
    "KEY",
    "FOREIGN",
    "REFERENCES",
    "NOT",
    "NULL",
    "DEFAULT",
    "UNIQUE",
    "AND",
    "OR",
    "IN",
    "LIKE",
    "IS",
    "BETWEEN",
    "WITH",
    "DISTINCT",
    "UNION",
    "ALL",
    "CASE",
    "WHEN",
    "THEN",
    "ELSE",
    "END",
    "RETURNING"
  ]);
  var PYTHON_BUILTIN_TYPES = /* @__PURE__ */ new Set([
    "int",
    "str",
    "bool",
    "float",
    "list",
    "dict",
    "tuple",
    "set",
    "bytes",
    "object",
    "type"
  ]);
  var RUST_BUILTIN_TYPES = /* @__PURE__ */ new Set([
    "bool",
    "char",
    "str",
    "String",
    "i8",
    "i16",
    "i32",
    "i64",
    "i128",
    "isize",
    "u8",
    "u16",
    "u32",
    "u64",
    "u128",
    "usize",
    "f32",
    "f64",
    "Vec",
    "Option",
    "Result",
    "Box",
    "Rc",
    "Arc"
  ]);
  var GO_BUILTIN_TYPES = /* @__PURE__ */ new Set([
    "bool",
    "string",
    "int",
    "int8",
    "int16",
    "int32",
    "int64",
    "uint",
    "uint8",
    "uint16",
    "uint32",
    "uint64",
    "byte",
    "rune",
    "float32",
    "float64",
    "complex64",
    "complex128",
    "error",
    "any"
  ]);
  function normaliseHighlightLanguage(language) {
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
  function highlightCode(code, language) {
    const lang = normaliseHighlightLanguage(language);
    if (lang === "plain") return escapeHtml(code);
    if (lang === "diff") return highlightDiff(code);
    const tokens = tokenize(code, lang);
    return tokens.map(renderToken).join("");
  }
  function renderToken(token) {
    const cls = `tok-${token.type}`;
    return `<span class="${cls}">${escapeHtml(token.value)}</span>`;
  }
  function escapeHtml(text) {
    return text.replace(/[&<>"']/g, (c) => {
      switch (c) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        case "'":
          return "&#39;";
        default:
          return c;
      }
    });
  }
  function highlightDiff(code) {
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
  function tokenize(code, lang) {
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
  function scan(code, specs) {
    const out = [];
    let i = 0;
    let pending = "";
    const flushPending = () => {
      if (pending) {
        out.push({ type: "foreground", value: pending });
        pending = "";
      }
    };
    while (i < code.length) {
      let matched = null;
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
  function tokenizeC(code, lang) {
    const keywords = KEYWORDS_JS;
    const specs = [
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
        }
      },
      { re: /[+\-*/%&|^!=<>?:]+/y, type: "operator" },
      { re: /[{}()[\];,.]/y, type: "punctuation" }
    ];
    return scan(code, specs);
  }
  function tokenizePython(code) {
    const specs = [
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
        }
      },
      { re: /[+\-*/%&|^!=<>]+/y, type: "operator" },
      { re: /[{}()[\]:,.;]/y, type: "punctuation" }
    ];
    return scan(code, specs);
  }
  function tokenizeRust(code) {
    const specs = [
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
        }
      },
      { re: /->|=>|::|[+\-*/%&|^!=<>?]+/y, type: "operator" },
      { re: /[{}()[\];,.]/y, type: "punctuation" }
    ];
    return scan(code, specs);
  }
  function tokenizeGo(code) {
    const specs = [
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
        }
      },
      { re: /:=|<-|[+\-*/%&|^!=<>]+/y, type: "operator" },
      { re: /[{}()[\];,.]/y, type: "punctuation" }
    ];
    return scan(code, specs);
  }
  function tokenizeShell(code) {
    const specs = [
      { re: /#[^\n]*/y, type: "comment" },
      { re: /"(?:\\[\s\S]|\$\{[^}]*\}|\$[A-Za-z_][\w]*|[^"\\$])*"/y, type: "string" },
      { re: /'[^']*'/y, type: "string" },
      { re: /\$\{[^}]+\}/y, type: "variable" },
      { re: /\$[A-Za-z_][\w]*/y, type: "variable" },
      { re: /\$\d+/y, type: "variable" },
      { re: /\b\d+\b/y, type: "number" },
      {
        re: /\b[A-Za-z_][\w-]*/y,
        type: (m) => KEYWORDS_SHELL.has(m[0]) ? "keyword" : "variable"
      },
      { re: /--?[A-Za-z][\w-]*/y, type: "decorator" },
      { re: /\|\||&&|>>|<<|[|&;<>()]/y, type: "operator" }
    ];
    return scan(code, specs);
  }
  function tokenizeSql(code) {
    const specs = [
      { re: /--[^\n]*/y, type: "comment" },
      { re: /\/\*[\s\S]*?\*\//y, type: "comment" },
      { re: /'(?:''|[^'])*'/y, type: "string" },
      { re: /"(?:""|[^"])*"/y, type: "string" },
      { re: /\b\d+(?:\.\d+)?\b/y, type: "number" },
      {
        re: /\b[A-Za-z_][\w]*\b/y,
        type: (m) => KEYWORDS_SQL.has(m[0].toUpperCase()) ? "keyword" : "variable"
      },
      { re: /[+\-*/%=<>!]+/y, type: "operator" },
      { re: /[(),;.]/y, type: "punctuation" }
    ];
    return scan(code, specs);
  }
  function tokenizeJson(code) {
    const specs = [
      { re: /\/\/[^\n]*/y, type: "comment" },
      // tolerate jsonc
      { re: /\/\*[\s\S]*?\*\//y, type: "comment" },
      {
        re: /"(?:\\[\s\S]|[^"\\])*"(?=\s*:)/y,
        type: "property"
      },
      { re: /"(?:\\[\s\S]|[^"\\])*"/y, type: "string" },
      { re: /\b(?:true|false|null)\b/y, type: "constant" },
      { re: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y, type: "number" },
      { re: /[{}[\]:,]/y, type: "punctuation" }
    ];
    return scan(code, specs);
  }
  function tokenizeCss(code) {
    const specs = [
      { re: /\/\*[\s\S]*?\*\//y, type: "comment" },
      { re: /"(?:\\[\s\S]|[^"\\])*"/y, type: "string" },
      { re: /'(?:\\[\s\S]|[^'\\])*'/y, type: "string" },
      { re: /@[A-Za-z-]+/y, type: "decorator" },
      { re: /#[\da-fA-F]{3,8}\b/y, type: "constant" },
      { re: /-?\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|deg|s|ms)?/y, type: "number" },
      { re: /--[A-Za-z_-][\w-]*/y, type: "variable" },
      { re: /[A-Za-z-]+(?=\s*:)/y, type: "property" },
      { re: /[.#&][A-Za-z_][\w-]*/y, type: "attribute" },
      { re: /[{}();,:]/y, type: "punctuation" }
    ];
    return scan(code, specs);
  }
  function tokenizeMarkup(code) {
    const specs = [
      { re: /<!--[\s\S]*?-->/y, type: "comment" },
      { re: /<!\[CDATA\[[\s\S]*?\]\]>/y, type: "comment" },
      { re: /<!DOCTYPE[^>]+>/y, type: "decorator" },
      { re: /"(?:[^"\\]|\\[\s\S])*"/y, type: "string" },
      { re: /'(?:[^'\\]|\\[\s\S])*'/y, type: "string" },
      { re: /<\/?[A-Za-z][\w-]*/y, type: "tag" },
      { re: /\/?>/y, type: "tag" },
      { re: /[A-Za-z_:][\w-]*(?==)/y, type: "attribute" },
      { re: /=/y, type: "operator" },
      { re: /&[#\w]+;/y, type: "escape" }
    ];
    return scan(code, specs);
  }
  function tokenizeYaml(code) {
    const specs = [
      { re: /#[^\n]*/y, type: "comment" },
      { re: /"(?:\\[\s\S]|[^"\\])*"/y, type: "string" },
      { re: /'[^']*'/y, type: "string" },
      { re: /^---$/my, type: "decorator" },
      { re: /^[ \t]*-\s/my, type: "punctuation" },
      { re: /^\s*[A-Za-z_][\w-]*(?=\s*:)/my, type: "property" },
      { re: /\b(?:true|false|null|yes|no|on|off)\b/y, type: "constant" },
      { re: /-?\b\d+(?:\.\d+)?\b/y, type: "number" },
      { re: /[&*][A-Za-z_][\w-]*/y, type: "decorator" },
      { re: /[{}[\],:]/y, type: "punctuation" }
    ];
    return scan(code, specs);
  }
  function tokenizeMarkdown(code) {
    const specs = [
      { re: /^#{1,6}\s.+/my, type: "keyword" },
      { re: /^>\s.+/my, type: "comment" },
      { re: /^[*+-]\s/my, type: "punctuation" },
      { re: /`[^`]+`/y, type: "string" },
      { re: /\*\*[^*]+\*\*/y, type: "keyword" },
      { re: /_[^_]+_/y, type: "type" },
      { re: /\[[^\]]+\]\([^)]+\)/y, type: "decorator" },
      { re: /https?:\/\/\S+/y, type: "decorator" }
    ];
    return scan(code, specs);
  }

  // src/webview/chat-main.ts
  var vscode = acquireVsCodeApi();
  var state = {
    settings: null,
    sessions: [],
    activeSession: null,
    activeSessionId: null,
    project: null,
    catalog: { models: [], agents: [], skills: [], mcpServers: [], documents: [], maxAgentSpawns: 3 },
    backendStatus: "unconfigured",
    apiOrigin: "",
    sidebarOpen: false,
    settingsOpen: false,
    modelPickerOpen: false,
    agentPickerOpen: false,
    draft: "",
    streaming: false,
    expandedTimelines: /* @__PURE__ */ new Set(),
    expandedEditCards: /* @__PURE__ */ new Set()
  };
  var PROVIDER_LABELS = {
    openai: "OpenAI",
    openrouter: "OpenRouter",
    google: "Google",
    ollama: "Ollama",
    "ollama-internal": "Ollama (internal)",
    llamacpp: "llama.cpp",
    lmstudio: "LM Studio",
    custom: "Custom"
  };
  var root = document.getElementById("root");
  function send(msg) {
    vscode.postMessage(msg);
  }
  function effective() {
    const s = state.settings;
    const o = state.activeSession?.overrides ?? {};
    const fallbackModel = state.catalog.models.find((m) => m.enabled);
    return {
      provider: o.provider ?? fallbackModel?.provider,
      model: o.model ?? fallbackModel?.modelId,
      chatMode: o.chatMode ?? s?.chatMode ?? "normal",
      useRag: o.useRag ?? s?.useRag ?? false,
      toolsEnabled: o.toolsEnabled ?? s?.toolsEnabled ?? true,
      agentIds: o.agentIds ?? [],
      skillIds: o.skillIds ?? [],
      mcpServerIds: o.mcpServerIds ?? []
    };
  }
  function setOverrides(partial) {
    if (!state.activeSession) return;
    send({ type: "setOverrides", sessionId: state.activeSession.id, overrides: partial });
  }
  function render() {
    if (!root.firstChild) {
      root.innerHTML = shellHtml();
      bindShell();
    }
    renderProjectBar();
    renderSidebar();
    renderHeader();
    renderTranscript();
    renderComposer();
    applySettings();
    applyModelPicker();
    applyAgentPicker();
    renderBackendBanner();
  }
  function shellHtml() {
    return `
    <div class="chat-shell">
      <aside class="chat-sidebar" id="chat-sidebar" hidden>
        <header class="chat-sidebar-header">
          <span>Chats</span>
          <button class="icon-btn" id="sidebar-close" title="Close" aria-label="Close">\u2715</button>
        </header>
        <div class="chat-sidebar-actions">
          <button class="ghost-btn" id="sidebar-new">+  New chat</button>
        </div>
        <div class="chat-sidebar-list" id="session-list"></div>
        <footer class="chat-sidebar-footer">
          <button class="ghost-btn small" id="sidebar-refresh" title="Refresh chats from Chatllm">\u21BB  Refresh</button>
        </footer>
      </aside>
      <div class="chat-main">
        <div class="project-bar" id="project-bar"></div>
        <header class="chat-header">
          <button class="icon-btn header-back" id="sidebar-toggle" title="Show chats" aria-label="Show chats">\u2190</button>
          <div class="chat-title" id="chat-title">New chat</div>
          <div class="header-actions">
            <button class="icon-btn" id="header-pipeline" title="Open pipeline" aria-label="Open pipeline">\u25F0</button>
            <button class="icon-btn" id="header-history" title="Chat history" aria-label="History">\u29D6</button>
            <button class="icon-btn" id="header-settings" title="Settings" aria-label="Settings">\u2699</button>
            <button class="icon-btn" id="new-chat" title="New chat" aria-label="New chat">+</button>
          </div>
        </header>
        <div class="backend-banner" id="backend-banner" hidden></div>
        <section class="chat-transcript" id="transcript"></section>
        <footer class="chat-composer">
          <div class="composer-card">
            <textarea id="composer" placeholder="Ask for follow-up changes\u2026" rows="1"></textarea>
            <div class="composer-toolbar" id="chip-row"></div>
          </div>
          <div class="composer-foot">
            <button class="chip chip-foot" id="chip-rag" title="Use indexed documents (RAG)">
              <span class="chip-dot"></span>
              <span id="chip-rag-label">Work locally</span>
            </button>
            <div class="composer-hints" id="composer-hints"></div>
          </div>
        </footer>
      </div>
      <div class="modal-backdrop" id="modal-backdrop" hidden></div>
      <div class="popover" id="model-picker" hidden></div>
      <div class="popover" id="agent-picker" hidden></div>
      <aside class="settings-overlay" id="settings-overlay" hidden>
        <header class="settings-overlay-header">
          <span>Chatllm Settings</span>
          <button class="icon-btn" id="settings-close" title="Close settings" aria-label="Close settings">\u2715</button>
        </header>
        <div class="settings-grid" id="settings-form"></div>
      </aside>
    </div>
  `;
  }
  function bindShell() {
    root.querySelector("#sidebar-toggle")?.addEventListener("click", () => {
      state.sidebarOpen = !state.sidebarOpen;
      applySidebar();
    });
    root.querySelector("#sidebar-close")?.addEventListener("click", () => {
      state.sidebarOpen = false;
      applySidebar();
    });
    root.querySelector("#sidebar-new")?.addEventListener("click", () => send({ type: "newSession" }));
    root.querySelector("#sidebar-refresh")?.addEventListener("click", () => send({ type: "refreshSessions" }));
    root.querySelector("#new-chat")?.addEventListener("click", () => send({ type: "newSession" }));
    root.querySelector("#header-pipeline")?.addEventListener("click", () => send({ type: "openPipeline" }));
    root.querySelector("#header-history")?.addEventListener("click", () => {
      state.sidebarOpen = true;
      applySidebar();
    });
    root.querySelector("#header-settings")?.addEventListener("click", () => {
      state.settingsOpen = true;
      applySettings();
    });
    root.querySelector("#settings-close")?.addEventListener("click", () => {
      state.settingsOpen = false;
      applySettings();
    });
    root.querySelector("#modal-backdrop")?.addEventListener("click", () => {
      if (state.modelPickerOpen) {
        state.modelPickerOpen = false;
        applyModelPicker();
      }
      if (state.agentPickerOpen) {
        state.agentPickerOpen = false;
        applyAgentPicker();
      }
      if (state.settingsOpen) {
        state.settingsOpen = false;
        applySettings();
      }
    });
    const composer = root.querySelector("#composer");
    composer.addEventListener("input", () => {
      state.draft = composer.value;
      autosize(composer);
      renderComposerHints();
    });
    composer.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submit();
      }
    });
  }
  function submit() {
    if (!state.activeSession) return;
    if (state.streaming) {
      send({ type: "cancelMessage", sessionId: state.activeSession.id });
      return;
    }
    const composer = root.querySelector("#composer");
    const text = composer.value.trim();
    if (!text) return;
    send({ type: "sendMessage", sessionId: state.activeSession.id, content: text });
    composer.value = "";
    state.draft = "";
    autosize(composer);
    renderComposerHints();
  }
  function autosize(el) {
    el.style.height = "auto";
    const max = 200;
    el.style.height = Math.min(el.scrollHeight, max) + "px";
  }
  function applySidebar() {
    const el = root.querySelector("#chat-sidebar");
    if (el) el.toggleAttribute("hidden", !state.sidebarOpen);
  }
  function applySettings() {
    const el = root.querySelector("#settings-overlay");
    const backdrop = root.querySelector("#modal-backdrop");
    if (el) el.toggleAttribute("hidden", !state.settingsOpen);
    if (backdrop) backdrop.toggleAttribute("hidden", !(state.settingsOpen || state.modelPickerOpen || state.agentPickerOpen));
    if (state.settingsOpen) renderSettings();
  }
  function applyModelPicker() {
    const el = root.querySelector("#model-picker");
    const backdrop = root.querySelector("#modal-backdrop");
    if (el) el.toggleAttribute("hidden", !state.modelPickerOpen);
    if (backdrop) backdrop.toggleAttribute("hidden", !(state.settingsOpen || state.modelPickerOpen || state.agentPickerOpen));
    if (state.modelPickerOpen) renderModelPicker();
  }
  function applyAgentPicker() {
    const el = root.querySelector("#agent-picker");
    const backdrop = root.querySelector("#modal-backdrop");
    if (el) el.toggleAttribute("hidden", !state.agentPickerOpen);
    if (backdrop) backdrop.toggleAttribute("hidden", !(state.settingsOpen || state.modelPickerOpen || state.agentPickerOpen));
    if (state.agentPickerOpen) renderAgentPicker();
  }
  function renderProjectBar() {
    const bar = root.querySelector("#project-bar");
    if (!bar) return;
    if (!state.project || state.project.source === "none") {
      bar.innerHTML = `<span class="project-name">No workspace folder</span>`;
      return;
    }
    const icon = state.project.source === "git" ? "\u2387" : "\u25A2";
    const subtitle = state.project.source === "git" ? state.project.remoteUrl ?? state.project.id : state.project.rootPath ?? "";
    const branch = state.project.branch ? ` <span class="project-branch">\u2387 ${escapeHtml2(state.project.branch)}</span>` : "";
    bar.innerHTML = `
    <span class="project-icon">${icon}</span>
    <div class="project-text">
      <div class="project-name">${escapeHtml2(state.project.name)}${branch}</div>
      <div class="project-subtitle" title="${escapeAttr(subtitle)}">${escapeHtml2(subtitle)}</div>
    </div>
  `;
  }
  function renderSidebar() {
    const list = root.querySelector("#session-list");
    if (!list) return;
    list.innerHTML = "";
    if (state.sessions.length === 0) {
      list.innerHTML = `<div class="sidebar-empty">No chats yet for this project.</div>`;
      return;
    }
    for (const s of state.sessions) {
      const row = document.createElement("div");
      row.className = "session-row" + (s.id === state.activeSessionId ? " active" : "");
      const time = relativeTime(s.updatedAt);
      const tag = s.remote ? "" : `<span class="session-tag">draft</span>`;
      row.innerHTML = `
      <div class="session-row-main">
        <div class="session-row-title">${escapeHtml2(s.title)} ${tag}</div>
        <div class="session-row-meta">${s.messageCount} \xB7 ${time}</div>
      </div>
      <button class="icon-btn session-delete" title="Delete" aria-label="Delete">\u2715</button>
    `;
      row.addEventListener("click", (event) => {
        if (event.target.closest(".session-delete")) return;
        send({ type: "openSession", sessionId: s.id });
        state.sidebarOpen = false;
        applySidebar();
      });
      row.querySelector(".session-delete")?.addEventListener("click", (event) => {
        event.stopPropagation();
        send({ type: "deleteSession", sessionId: s.id });
      });
      list.appendChild(row);
    }
  }
  function renderHeader() {
    const title = root.querySelector("#chat-title");
    if (!title) return;
    const t = state.activeSession?.title || "New chat";
    title.textContent = t;
    title.title = "Click to rename";
    title.onclick = () => {
      if (!state.activeSession) return;
      const next = window.prompt("Rename chat", state.activeSession.title);
      if (next != null) send({ type: "renameSession", sessionId: state.activeSession.id, title: next });
    };
  }
  function renderBackendBanner() {
    const banner = root.querySelector("#backend-banner");
    if (!banner) return;
    if (state.backendStatus === "ok") {
      banner.toggleAttribute("hidden", true);
      return;
    }
    banner.toggleAttribute("hidden", false);
    if (state.backendStatus === "unconfigured") {
      banner.className = "backend-banner unconfigured";
      banner.innerHTML = `Chatllm API origin is not configured. Set <code>CHATLLM_API_ORIGIN</code> in your environment to start chatting.`;
    } else if (state.backendStatus === "unauthorized") {
      banner.className = "backend-banner unauthorized";
      banner.innerHTML = `VS Code is not signed in to Chatllm. Close this window and reopen the project from the Chatllm desktop app while you are logged in.`;
    } else {
      banner.className = "backend-banner unreachable";
      banner.innerHTML = `Can't reach Chatllm at <code>${escapeHtml2(state.apiOrigin)}</code>. <button id="retry-backend" class="link-btn">Retry</button>`;
      banner.querySelector("#retry-backend")?.addEventListener("click", () => send({ type: "refreshCatalog" }));
    }
  }
  function renderTranscript() {
    const transcript = root.querySelector("#transcript");
    if (!transcript) return;
    transcript.innerHTML = "";
    const messages = state.activeSession?.messages ?? [];
    if (messages.length === 0) {
      transcript.appendChild(renderEmptyState());
      return;
    }
    for (const m of messages) {
      transcript.appendChild(renderMessage(m));
    }
    transcript.scrollTop = transcript.scrollHeight;
  }
  function renderEmptyState() {
    const el = document.createElement("div");
    el.className = "empty-state";
    const projectLine = state.project && state.project.source !== "none" ? `<div class="empty-project">Chats here live with <strong>${escapeHtml2(state.project.name)}</strong>${state.project.source === "git" ? " (git project)" : ""}.</div>` : "";
    el.innerHTML = `
    <h2>What can I build for you?</h2>
    ${projectLine}
    <div class="empty-commands">
      <button data-prompt="/spec ">/spec   draft EARS requirements</button>
      <button data-prompt="/design ">/design   draft design.md</button>
      <button data-prompt="/tasks ">/tasks   generate task contracts</button>
    </div>
  `;
    for (const b of el.querySelectorAll(".empty-commands button")) {
      b.addEventListener("click", () => {
        const composer = root.querySelector("#composer");
        composer.value = b.dataset.prompt ?? "";
        composer.focus();
        autosize(composer);
      });
    }
    return el;
  }
  function renderMessage(message) {
    const turn = document.createElement("article");
    turn.className = `turn turn-${message.role}` + (message.status === "streaming" ? " streaming" : "") + (message.status === "error" ? " error" : "");
    turn.dataset.messageId = message.id;
    if (message.role === "user") {
      turn.innerHTML = `
      <div class="bubble bubble-user">
        <div class="turn-content"></div>
      </div>
      <div class="turn-avatar avatar-user">U</div>
    `;
      const content2 = turn.querySelector(".turn-content");
      content2.innerHTML = renderMarkdownish(message.content);
      bindMarkdownExtras(content2);
      return turn;
    }
    const timelineHtml = renderTimelineBlock(message);
    const editCardHtml = renderEditCard(message);
    const showWorking = message.status === "streaming" && !message.content && !message.tools?.length;
    turn.innerHTML = `
    <div class="assistant-meta">
      ${timelineHtml}
      ${editCardHtml}
      ${showWorking ? `<div class="assistant-status"><span class="turn-indicator"></span><span>Working\u2026</span></div>` : ""}
    </div>
    <div class="turn-content"></div>
    ${message.status === "error" && message.error ? `<div class="turn-error">${escapeHtml2(message.error)}</div>` : ""}
    ${message.status === "complete" ? `<div class="assistant-actions">
      <button class="icon-btn small" title="Copy" aria-label="Copy" data-act="copy">\u2398</button>
      <button class="icon-btn small" title="Helpful" aria-label="Helpful" data-act="up">\u{1F44D}</button>
      <button class="icon-btn small" title="Not helpful" aria-label="Not helpful" data-act="down">\u{1F44E}</button>
      <button class="icon-btn small" title="Share" aria-label="Share" data-act="share">\u21AA</button>
    </div>` : ""}
  `;
    const content = turn.querySelector(".turn-content");
    content.innerHTML = renderMarkdownish(message.content);
    bindMarkdownExtras(content);
    bindAssistantMeta(turn, message);
    turn.querySelector('[data-act="copy"]')?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(message.content);
      } catch {
      }
    });
    return turn;
  }
  function renderTimelineBlock(message) {
    const tools = message.tools ?? [];
    if (tools.length === 0 && message.status !== "streaming") return "";
    const duration = formatWorkDuration(message);
    const expanded = state.expandedTimelines.has(message.id) || message.status === "streaming";
    const chevron = expanded ? "\u25BE" : "\u25B8";
    const rows = tools.map((t) => {
      const icon = t.status === "running" ? `<span class="turn-indicator"></span>` : t.status === "error" ? "\u2717" : "\u2713";
      const label = escapeHtml2(t.summary ?? t.name);
      return `<div class="timeline-row status-${t.status}"><span class="timeline-icon">${icon}</span><span>${label}</span></div>`;
    }).join("");
    const body = expanded && rows ? `<div class="timeline-body">${rows}</div>` : expanded && message.status === "streaming" ? `<div class="timeline-body timeline-empty">Waiting for tool activity\u2026</div>` : "";
    return `
    <button class="worked-toggle" data-message-id="${escapeAttr(message.id)}" type="button">
      <span class="worked-chevron">${chevron}</span>
      <span class="worked-label">${escapeHtml2(duration)}</span>
    </button>
    ${body}
  `;
  }
  function renderEditCard(message) {
    const files = message.editedFiles ?? [];
    if (files.length === 0) return "";
    const totalAdds = files.reduce((n, f) => n + f.additions, 0);
    const totalDels = files.reduce((n, f) => n + f.deletions, 0);
    const expanded = state.expandedEditCards.has(message.id);
    const chevron = expanded ? "\u25BE" : "\u25B8";
    const fileRows = files.map((f) => {
      const stats = formatFileStats(f);
      return `
      <button class="edit-file-row" type="button" data-path="${escapeAttr(f.path)}" title="Open ${escapeAttr(f.path)}">
        <span class="edit-file-icon">\u2637</span>
        <span class="edit-file-path">${escapeHtml2(f.path)}</span>
        <span class="edit-file-stats">${stats}</span>
      </button>
    `;
    }).join("");
    return `
    <div class="edit-card">
      <div class="edit-card-header">
        <button class="edit-card-toggle" type="button" data-message-id="${escapeAttr(message.id)}">
          <span class="edit-card-icon">\u2637</span>
          <span>Edited ${files.length} file${files.length === 1 ? "" : "s"}</span>
          <span class="edit-card-stats">${formatDiffSummary(totalAdds, totalDels)}</span>
          <span class="edit-card-chevron">${chevron}</span>
        </button>
        <div class="edit-card-actions">
          <button class="edit-action" type="button" data-act="undo-all" data-message-id="${escapeAttr(message.id)}">Undo</button>
          <button class="edit-action primary" type="button" data-act="review-all" data-message-id="${escapeAttr(message.id)}">Review</button>
        </div>
      </div>
      ${expanded ? `<div class="edit-card-files">${fileRows}</div>` : ""}
    </div>
  `;
  }
  function bindAssistantMeta(turn, message) {
    turn.querySelector(".worked-toggle")?.addEventListener("click", () => {
      if (state.expandedTimelines.has(message.id)) state.expandedTimelines.delete(message.id);
      else state.expandedTimelines.add(message.id);
      updateAssistantMetaInDom(message.id);
    });
    turn.querySelector(".edit-card-toggle")?.addEventListener("click", () => {
      if (state.expandedEditCards.has(message.id)) state.expandedEditCards.delete(message.id);
      else state.expandedEditCards.add(message.id);
      updateAssistantMetaInDom(message.id);
    });
    turn.querySelectorAll(".edit-file-row").forEach((btn) => {
      btn.addEventListener("click", () => {
        const path = btn.dataset.path;
        if (path) send({ type: "revealFile", path });
      });
    });
    turn.querySelector('[data-act="undo-all"]')?.addEventListener("click", () => {
      for (const f of message.editedFiles ?? []) send({ type: "undoEdit", path: f.path });
    });
    turn.querySelector('[data-act="review-all"]')?.addEventListener("click", () => {
      const first = message.editedFiles?.[0];
      if (first) send({ type: "revealFile", path: first.path });
    });
  }
  function updateAssistantMetaInDom(messageId) {
    const session = state.activeSession;
    if (!session) return;
    const message = session.messages.find((m) => m.id === messageId);
    if (!message || message.role !== "assistant") return;
    const turn = root.querySelector(`.turn[data-message-id="${cssAttr(messageId)}"]`);
    if (!turn) return;
    const meta = turn.querySelector(".assistant-meta");
    if (!meta) return;
    meta.innerHTML = `
    ${renderTimelineBlock(message)}
    ${renderEditCard(message)}
    ${message.status === "streaming" && !message.content && !message.tools?.length ? `<div class="assistant-status"><span class="turn-indicator"></span><span>Working\u2026</span></div>` : ""}
  `;
    bindAssistantMeta(turn, message);
  }
  function formatWorkDuration(message) {
    const start = message.startedAt ?? message.createdAt;
    const end = message.completedAt ?? (message.status === "streaming" ? Date.now() : start);
    const ms = Math.max(0, end - start);
    if (message.status === "streaming") {
      if (ms < 1500) return "Working\u2026";
      return `Working for ${formatDuration(ms)}\u2026`;
    }
    if (ms < 1500 && !message.tools?.length) return "Finished";
    return `Worked for ${formatDuration(ms)}`;
  }
  function formatDuration(ms) {
    const sec = Math.floor(ms / 1e3);
    if (sec < 60) return `${Math.max(1, sec)}s`;
    const min = Math.floor(sec / 60);
    const rem = sec % 60;
    return rem ? `${min}m ${rem}s` : `${min}m`;
  }
  function formatFileStats(file) {
    return formatDiffSummary(file.additions, file.deletions);
  }
  function formatDiffSummary(additions, deletions) {
    const parts = [];
    if (additions > 0) parts.push(`+${additions}`);
    if (deletions > 0) parts.push(`-${deletions}`);
    return parts.length ? parts.join(" ") : "+0";
  }
  function upsertTool(tools, entry) {
    const list = tools ? [...tools] : [];
    const idx = list.findIndex((t) => t.id === entry.id);
    if (idx >= 0) list[idx] = { ...list[idx], ...entry };
    else list.push(entry);
    return list;
  }
  function renderComposer() {
    const toolbar = root.querySelector("#chip-row");
    if (!toolbar) return;
    const eff = effective();
    const modelLabel = describeModel(eff.provider, eff.model);
    const agentCount = eff.agentIds.length;
    const modeLabel = eff.chatMode === "agent" ? "Agent" : "Normal";
    toolbar.innerHTML = `
    <button class="composer-icon-btn" id="attach-btn" title="Attach files (coming soon)" aria-label="Attach">+</button>
    <button class="chip chip-access" id="chip-mode" title="Toggle agent mode">
      <span class="chip-icon shield">\u2756</span>
      <span>${escapeHtml2(modeLabel)}</span>
      <span class="chip-caret">\u25BE</span>
    </button>
    <button class="chip${eff.toolsEnabled ? " chip-on" : ""}" id="chip-tools" title="Toggle tools">
      \u2692 Tools
    </button>
    <button class="chip${agentCount > 0 ? " chip-on" : ""}" id="chip-agents" title="Attach agents from Chatllm" ${state.catalog.agents.length === 0 ? "disabled" : ""}>
      \u269B Agents${agentCount ? ` (${agentCount})` : ""}
    </button>
    <span class="composer-spacer"></span>
    <button class="chip chip-model" id="chip-model" title="Pick model for this chat" ${state.catalog.models.length === 0 ? "disabled" : ""}>
      <span>${escapeHtml2(modelLabel)}</span>
      <span class="chip-caret">\u25BE</span>
    </button>
    <button class="send-btn" id="send-btn" title="Send" aria-label="Send"></button>
  `;
    toolbar.querySelector("#chip-model")?.addEventListener("click", () => {
      state.modelPickerOpen = !state.modelPickerOpen;
      applyModelPicker();
    });
    toolbar.querySelector("#chip-mode")?.addEventListener("click", () => {
      setOverrides({ chatMode: eff.chatMode === "agent" ? "normal" : "agent" });
    });
    toolbar.querySelector("#chip-tools")?.addEventListener("click", () => {
      setOverrides({ toolsEnabled: !eff.toolsEnabled });
    });
    toolbar.querySelector("#chip-agents")?.addEventListener("click", () => {
      state.agentPickerOpen = !state.agentPickerOpen;
      applyAgentPicker();
    });
    toolbar.querySelector("#send-btn")?.addEventListener("click", () => submit());
    const ragBtn = root.querySelector("#chip-rag");
    if (ragBtn) {
      ragBtn.classList.toggle("chip-on", eff.useRag);
      const label = ragBtn.querySelector("#chip-rag-label");
      if (label) label.textContent = eff.useRag ? "Use project knowledge" : "Work locally";
      ragBtn.onclick = () => setOverrides({ useRag: !eff.useRag });
    }
    const sendBtn = toolbar.querySelector("#send-btn");
    if (sendBtn) {
      sendBtn.classList.toggle("streaming", state.streaming);
      sendBtn.innerHTML = state.streaming ? `<span class="stop-dot"></span>` : `\u2191`;
      sendBtn.title = state.streaming ? "Stop" : "Send";
    }
    renderComposerHints();
  }
  function renderComposerHints() {
    const hints = root.querySelector("#composer-hints");
    if (!hints) return;
    const draft = state.draft.trimStart();
    if (draft.startsWith("/")) {
      const matches = ["/spec", "/design", "/tasks"].filter((c) => c.startsWith(draft.split(/\s/)[0]));
      if (matches.length) {
        hints.innerHTML = matches.map((c) => `<button class="hint" data-cmd="${c}">${c}</button>`).join("");
        for (const b of hints.querySelectorAll(".hint")) {
          b.addEventListener("click", () => {
            const composer = root.querySelector("#composer");
            composer.value = (b.dataset.cmd ?? "") + " ";
            composer.focus();
            state.draft = composer.value;
            autosize(composer);
            renderComposerHints();
          });
        }
        return;
      }
    }
    hints.innerHTML = "";
  }
  function renderModelPicker() {
    const el = root.querySelector("#model-picker");
    if (!el || !state.modelPickerOpen) return;
    const eff = effective();
    const grouped = groupModels(state.catalog.models);
    if (grouped.length === 0) {
      el.innerHTML = `
      <header class="popover-header">
        <span>Choose model</span>
        <button class="icon-btn" id="picker-close">\u2715</button>
      </header>
      <div class="popover-empty">
        No models configured in Chatllm. Open the Chatllm app and add a model under Settings \u2192 Models.
      </div>
    `;
    } else {
      el.innerHTML = `
      <header class="popover-header">
        <span>Model for this chat</span>
        <button class="icon-btn" id="picker-close">\u2715</button>
      </header>
      <div class="popover-body">
        ${grouped.map((g) => `
          <section class="popover-group">
            <h4>${escapeHtml2(g.label)}</h4>
            <ul>
              ${g.models.map((m) => {
        const selected = m.provider === eff.provider && m.modelId === eff.model;
        const cap = (m.capabilities ?? []).slice(0, 3).join(", ");
        return `<li class="popover-row${selected ? " selected" : ""}" data-provider="${escapeAttr(m.provider)}" data-model="${escapeAttr(m.modelId)}">
                  <div class="popover-row-title">${escapeHtml2(m.displayName)}</div>
                  <div class="popover-row-detail">${escapeHtml2(cap || m.modelId)}</div>
                </li>`;
      }).join("")}
            </ul>
          </section>
        `).join("")}
      </div>
    `;
    }
    el.querySelector("#picker-close")?.addEventListener("click", () => {
      state.modelPickerOpen = false;
      applyModelPicker();
    });
    for (const li of el.querySelectorAll(".popover-row")) {
      li.addEventListener("click", () => {
        setOverrides({
          provider: li.dataset.provider,
          model: li.dataset.model
        });
        state.modelPickerOpen = false;
        applyModelPicker();
      });
    }
  }
  function renderAgentPicker() {
    const el = root.querySelector("#agent-picker");
    if (!el || !state.agentPickerOpen) return;
    const eff = effective();
    if (state.catalog.agents.length === 0) {
      el.innerHTML = `
      <header class="popover-header">
        <span>Agents</span>
        <button class="icon-btn" id="agent-close">\u2715</button>
      </header>
      <div class="popover-empty">No agents configured in Chatllm.</div>
    `;
    } else {
      el.innerHTML = `
      <header class="popover-header">
        <span>Agents for this chat</span>
        <button class="icon-btn" id="agent-close">\u2715</button>
      </header>
      <div class="popover-body">
        <ul>
          ${state.catalog.agents.map((a) => {
        const selected = eff.agentIds.includes(a.id);
        return `<li class="popover-row${selected ? " selected" : ""}" data-id="${escapeAttr(a.id)}">
              <div class="popover-row-title">${escapeHtml2(a.name)}</div>
              <div class="popover-row-detail">${escapeHtml2(a.description || "")}</div>
            </li>`;
      }).join("")}
        </ul>
      </div>
    `;
    }
    el.querySelector("#agent-close")?.addEventListener("click", () => {
      state.agentPickerOpen = false;
      applyAgentPicker();
    });
    for (const li of el.querySelectorAll(".popover-row")) {
      li.addEventListener("click", () => {
        const id = li.dataset.id;
        const current = new Set(eff.agentIds);
        if (current.has(id)) current.delete(id);
        else current.add(id);
        setOverrides({ agentIds: [...current] });
      });
    }
  }
  function renderSettings() {
    const grid = root.querySelector("#settings-form");
    if (!grid || !state.settings) return;
    const s = state.settings;
    const projectLine = state.project && state.project.source !== "none" ? `<div class="hint">Active project: <strong>${escapeHtml2(state.project.name)}</strong> &mdash; ${escapeHtml2(state.project.source === "git" ? state.project.remoteUrl ?? state.project.id : state.project.rootPath ?? "")}</div>` : "";
    grid.innerHTML = `
    <h2>Connection</h2>
    <label>API origin</label>
    <div class="value">${escapeHtml2(state.apiOrigin || "(not configured)")}</div>
    <label>Status</label>
    <div class="value status-${state.backendStatus}">${escapeHtml2(state.backendStatus)}</div>
    ${projectLine}

    <h2>Local defaults</h2>
    <label for="set-mode">Model selection mode</label>
    <select id="set-mode" data-key="modelSelection">
      <option value="manual" ${s.modelSelection === "manual" ? "selected" : ""}>manual</option>
      <option value="auto" ${s.modelSelection === "auto" ? "selected" : ""}>auto</option>
    </select>
    <label for="set-chatmode">Default chat mode</label>
    <select id="set-chatmode" data-key="chatMode">
      <option value="normal" ${s.chatMode === "normal" ? "selected" : ""}>normal</option>
      <option value="agent" ${s.chatMode === "agent" ? "selected" : ""}>agent</option>
    </select>
    <label for="set-rag">RAG by default</label>
    <div><input id="set-rag" data-key="useRag" type="checkbox" ${s.useRag ? "checked" : ""} /></div>
    <label for="set-tools">Tools by default</label>
    <div><input id="set-tools" data-key="toolsEnabled" type="checkbox" ${s.toolsEnabled ? "checked" : ""} /></div>
    <label for="set-system">Local system prompt</label>
    <textarea id="set-system" data-key="systemPrompt" placeholder="(empty)">${escapeHtml2(s.systemPrompt)}</textarea>

    <h2>Integrations</h2>
    <label for="set-copilot">GitHub Copilot</label>
    <div>
      <div>
        <input id="set-copilot-models" data-key="copilot.modelsEnabled" type="checkbox" ${s.copilotModelsEnabled ? "checked" : ""} />
        <span class="hint inline">Enable Copilot model access (vscode.lm). Native Copilot UI stays hidden.</span>
      </div>
      <div>
        <input id="set-copilot-ui" data-key="copilot.enabled" type="checkbox" ${s.copilotUiEnabled ? "checked" : ""} />
        <span class="hint inline">Re-enable native Copilot UI. Toggling prompts a window reload.</span>
      </div>
      <div style="margin-top: 8px">
        <button class="btn" id="copilot-github-login" type="button">Sign in to GitHub for Copilot</button>
        <span class="hint inline">Uses VS Code GitHub auth, then links it to ChatLLM.</span>
      </div>
    </div>

    <div class="hint">Models, agents, MCP servers, and skills are managed in the Chatllm app. Per-chat picks are stored on the conversation.</div>
  `;
    for (const input of grid.querySelectorAll("[data-key]")) {
      input.addEventListener("change", () => emitSettingChange(input));
    }
    const loginBtn = grid.querySelector("#copilot-github-login");
    if (loginBtn) loginBtn.addEventListener("click", () => send({ type: "copilotGithubLogin" }));
  }
  function emitSettingChange(input) {
    const key = input.dataset.key;
    let value;
    if (input instanceof HTMLInputElement && input.type === "checkbox") value = input.checked;
    else value = input.value;
    send({ type: "updateSetting", key, value });
  }
  function groupModels(models) {
    const map = /* @__PURE__ */ new Map();
    for (const m of models) {
      const list = map.get(m.provider) ?? [];
      list.push(m);
      map.set(m.provider, list);
    }
    return Array.from(map.entries()).map(([provider, group]) => ({
      provider,
      label: PROVIDER_LABELS[provider] ?? provider,
      models: [...group].sort((a, b) => a.displayName.localeCompare(b.displayName))
    })).sort((a, b) => a.label.localeCompare(b.label));
  }
  function describeModel(provider, modelId) {
    if (!provider || !modelId) return state.catalog.models.length === 0 ? "No models configured" : "Pick a model";
    for (const m of state.catalog.models) {
      if (m.provider === provider && m.modelId === modelId) return m.displayName;
    }
    return `${PROVIDER_LABELS[provider] ?? provider} \xB7 ${modelId}`;
  }
  function relativeTime(ts) {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 6e4);
    if (m < 1) return "now";
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    return `${d}d`;
  }
  function escapeHtml2(value) {
    if (value == null) return "";
    return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
  }
  function escapeAttr(value) {
    return escapeHtml2(value);
  }
  function renderMarkdownish(text) {
    if (!text) return `<span class="placeholder">\u2026</span>`;
    return renderBlocks(text);
  }
  function renderBlocks(text) {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        const fenceMatch = line.match(/^\s*```\s*([\w+-]*)\s*$/);
        const lang = fenceMatch?.[1] ?? "";
        const code = [];
        i += 1;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
          code.push(lines[i]);
          i += 1;
        }
        i += 1;
        out.push(renderFenced(lang, code.join("\n")));
        continue;
      }
      const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        out.push(`<h${level} class="md-h md-h${level}">${renderInline(headingMatch[2])}</h${level}>`);
        i += 1;
        continue;
      }
      if (/^\s*(?:-\s*){3,}$/.test(line) || /^\s*(?:\*\s*){3,}$/.test(line) || /^\s*(?:_\s*){3,}$/.test(line)) {
        out.push(`<hr class="md-hr" />`);
        i += 1;
        continue;
      }
      if (/^\s*>\s?/.test(line)) {
        const quoteLines = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
          i += 1;
        }
        out.push(`<blockquote class="md-quote">${renderBlocks(quoteLines.join("\n"))}</blockquote>`);
        continue;
      }
      if (looksLikeTableRow(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const tableLines = [];
        while (i < lines.length && lines[i].trim() !== "" && looksLikeTableRow(lines[i])) {
          tableLines.push(lines[i]);
          i += 1;
        }
        out.push(renderTable(tableLines));
        continue;
      }
      if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
        const ordered = /^\s*\d+\.\s+/.test(line);
        const items = [];
        while (i < lines.length && (ordered ? /^\s*\d+\.\s+/.test(lines[i]) : /^\s*[-*+]\s+/.test(lines[i]))) {
          const rawItem = lines[i].replace(ordered ? /^\s*\d+\.\s+/ : /^\s*[-*+]\s+/, "");
          items.push(renderListItem(rawItem));
          i += 1;
        }
        const tag = ordered ? "ol" : "ul";
        out.push(`<${tag} class="md-list">${items.join("")}</${tag}>`);
        continue;
      }
      if (line.trim() === "") {
        i += 1;
        continue;
      }
      const paraLines = [line];
      i += 1;
      while (i < lines.length && lines[i].trim() !== "" && !/^\s*```/.test(lines[i]) && !/^(#{1,6})\s+/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) {
        paraLines.push(lines[i]);
        i += 1;
      }
      out.push(`<p class="md-para">${renderInline(paraLines.join("\n").replace(/\n/g, " "))}</p>`);
    }
    return out.join("");
  }
  function renderListItem(raw) {
    const taskMatch = raw.match(/^\[([ xX])\]\s+(.*)$/);
    if (taskMatch) {
      const checked = taskMatch[1].toLowerCase() === "x";
      return `<li class="md-task"><input type="checkbox" class="md-task-checkbox" disabled${checked ? " checked" : ""} /> <span>${renderInline(taskMatch[2])}</span></li>`;
    }
    return `<li class="md-list-item">${renderInline(raw)}</li>`;
  }
  function looksLikeTableRow(line) {
    if (!line.includes("|")) return false;
    return /^\s*\|?[^|]+\|/.test(line.trim());
  }
  function renderTable(lines) {
    if (lines.length < 2) return `<p class="md-para">${renderInline(lines.join(" "))}</p>`;
    const splitRow = (l) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
    const headers = splitRow(lines[0]);
    const aligns = splitRow(lines[1]).map((cell) => {
      const left = cell.startsWith(":");
      const right = cell.endsWith(":");
      if (left && right) return "center";
      if (right) return "right";
      if (left) return "left";
      return "";
    });
    const bodyRows = lines.slice(2).map((row) => splitRow(row));
    const thCells = headers.map((cell, idx) => {
      const align = aligns[idx];
      return `<th class="md-th" ${align ? `style="text-align:${align}"` : ""}>${renderInline(cell)}</th>`;
    }).join("");
    const trRows = bodyRows.map((row) => {
      const tds = row.map((cell, idx) => {
        const align = aligns[idx];
        return `<td class="md-td" ${align ? `style="text-align:${align}"` : ""}>${renderInline(cell)}</td>`;
      }).join("");
      return `<tr>${tds}</tr>`;
    }).join("");
    return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${thCells}</tr></thead><tbody>${trRows}</tbody></table></div>`;
  }
  function renderFenced(lang, code) {
    if (lang === "mermaid") {
      const idx = mermaidCounter++;
      const escaped = escapeAttr(code);
      return `<div class="md-mermaid" data-mermaid-block="${idx}" data-source="${escaped}">
      <div class="md-mermaid-head"><span>Mermaid</span><button class="md-mermaid-toggle" data-toggle="${idx}">Source</button></div>
      <div class="md-mermaid-canvas" data-canvas="${idx}"><span class="placeholder">Loading diagram\u2026</span></div>
      <pre class="md-pre" data-source-block="${idx}" hidden><code class="language-mermaid">${escapeHtml2(code)}</code></pre>
    </div>`;
    }
    const cls = lang ? ` language-${escapeAttr(lang)}` : "";
    const langLabel = lang || "text";
    const highlighted = highlightCode(code, lang);
    return `<div class="md-codeblock">
    <div class="md-codeblock-head"><span class="md-codeblock-lang">${escapeHtml2(langLabel)}</span><button class="md-codeblock-copy" data-copy>${"Copy"}</button></div>
    <pre class="md-pre"><code class="${cls.trim()}">${highlighted}</code></pre>
  </div>`;
  }
  function renderInline(text) {
    let out = "";
    let i = 0;
    while (i < text.length) {
      if (text[i] === "`") {
        const end = text.indexOf("`", i + 1);
        if (end > i) {
          out += `<code class="md-code">${escapeHtml2(text.slice(i + 1, end))}</code>`;
          i = end + 1;
          continue;
        }
      }
      if (text.startsWith("![", i)) {
        const labelEnd = text.indexOf("]", i + 2);
        if (labelEnd > i && text[labelEnd + 1] === "(") {
          const hrefEnd = text.indexOf(")", labelEnd + 2);
          if (hrefEnd > labelEnd) {
            const alt = text.slice(i + 2, labelEnd);
            const src = text.slice(labelEnd + 2, hrefEnd);
            out += `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" class="md-image" loading="lazy" />`;
            i = hrefEnd + 1;
            continue;
          }
        }
      }
      if (text[i] === "[") {
        const labelEnd = text.indexOf("]", i + 1);
        if (labelEnd > i && text[labelEnd + 1] === "(") {
          const hrefEnd = text.indexOf(")", labelEnd + 2);
          if (hrefEnd > labelEnd) {
            const label = text.slice(i + 1, labelEnd);
            const href = text.slice(labelEnd + 2, hrefEnd);
            out += `<a class="md-link" href="${escapeAttr(href)}" target="_blank" rel="noopener">${renderInline(label)}</a>`;
            i = hrefEnd + 1;
            continue;
          }
        }
      }
      if (text.startsWith("**", i)) {
        const end = text.indexOf("**", i + 2);
        if (end > i) {
          out += `<strong>${renderInline(text.slice(i + 2, end))}</strong>`;
          i = end + 2;
          continue;
        }
      }
      if (text[i] === "*" && text[i + 1] !== "*") {
        const end = text.indexOf("*", i + 1);
        if (end > i) {
          out += `<em>${renderInline(text.slice(i + 1, end))}</em>`;
          i = end + 1;
          continue;
        }
      }
      if (text[i] === "_" && /\W|^/.test(text[i - 1] ?? "")) {
        const end = text.indexOf("_", i + 1);
        if (end > i && /\W|$/.test(text[end + 1] ?? "")) {
          out += `<em>${renderInline(text.slice(i + 1, end))}</em>`;
          i = end + 1;
          continue;
        }
      }
      if (text.startsWith("~~", i)) {
        const end = text.indexOf("~~", i + 2);
        if (end > i) {
          out += `<del>${renderInline(text.slice(i + 2, end))}</del>`;
          i = end + 2;
          continue;
        }
      }
      if (text.startsWith("http", i)) {
        const urlMatch = text.slice(i).match(/^https?:\/\/[^\s)\]>"']+/);
        if (urlMatch) {
          const url = urlMatch[0];
          out += `<a class="md-link" href="${escapeAttr(url)}" target="_blank" rel="noopener">${escapeHtml2(url)}</a>`;
          i += url.length;
          continue;
        }
      }
      out += escapeHtmlChar(text[i]);
      i += 1;
    }
    return out;
  }
  function escapeHtmlChar(ch) {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      case "\n":
        return "<br />";
      default:
        return ch;
    }
  }
  var mermaidCounter = 0;
  var mermaidLoader = null;
  function loadMermaid() {
    if (!mermaidLoader) {
      mermaidLoader = new Promise((resolve) => {
        const existing = window.ChatllmMermaid;
        if (existing) return resolve(existing);
        const src = document.getElementById("root")?.dataset.mermaidSrc;
        if (!src) return resolve(null);
        const tag = document.createElement("script");
        tag.src = src;
        tag.onload = () => {
          const lib = window.ChatllmMermaid;
          resolve(lib ?? null);
        };
        tag.onerror = () => resolve(null);
        document.head.appendChild(tag);
      });
    }
    return mermaidLoader;
  }
  function bindMarkdownExtras(scope) {
    for (const btn of scope.querySelectorAll("[data-copy]")) {
      if (btn.dataset.bound === "1") continue;
      btn.dataset.bound = "1";
      btn.addEventListener("click", async () => {
        const code = btn.parentElement?.nextElementSibling?.textContent ?? "";
        try {
          await navigator.clipboard.writeText(code);
          const prev = btn.textContent;
          btn.textContent = "Copied";
          setTimeout(() => {
            btn.textContent = prev ?? "Copy";
          }, 1200);
        } catch {
        }
      });
    }
    for (const wrap of scope.querySelectorAll(".md-mermaid[data-mermaid-block]")) {
      if (wrap.dataset.bound === "1") continue;
      wrap.dataset.bound = "1";
      const idx = wrap.dataset.mermaidBlock ?? "";
      const source = wrap.dataset.source ?? "";
      const canvas = wrap.querySelector(`[data-canvas="${cssAttr(idx)}"]`);
      const sourceBlock = wrap.querySelector(`[data-source-block="${cssAttr(idx)}"]`);
      const toggle = wrap.querySelector(`[data-toggle="${cssAttr(idx)}"]`);
      toggle?.addEventListener("click", () => {
        const showSource = sourceBlock && sourceBlock.hasAttribute("hidden") ? true : false;
        if (showSource) {
          sourceBlock?.removeAttribute("hidden");
          if (canvas) canvas.hidden = true;
          if (toggle) toggle.textContent = "Diagram";
        } else {
          sourceBlock?.setAttribute("hidden", "");
          if (canvas) canvas.hidden = false;
          if (toggle) toggle.textContent = "Source";
        }
      });
      void loadMermaid().then(async (lib) => {
        if (!canvas) return;
        if (!lib) {
          canvas.innerHTML = `<span class="placeholder">Mermaid runtime unavailable.</span>`;
          return;
        }
        try {
          const decoded = decodeAttr(source);
          const svg = await lib.render(decoded);
          canvas.innerHTML = svg;
        } catch (err) {
          canvas.innerHTML = `<div class="md-mermaid-error">Failed to render diagram: ${escapeHtml2(err instanceof Error ? err.message : String(err))}</div>`;
        }
      });
    }
  }
  function decodeAttr(value) {
    return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  function appendChunkInDom(messageId, chunk) {
    const turn = root.querySelector(`.turn[data-message-id="${cssAttr(messageId)}"] .turn-content`);
    if (!turn) return;
    const session = state.activeSession;
    const fullMessage = session?.messages.find((m) => m.id === messageId);
    if (fullMessage) {
      turn.innerHTML = renderMarkdownish(fullMessage.content);
      bindMarkdownExtras(turn);
    } else {
      if (turn.querySelector(".placeholder")) turn.innerHTML = "";
      turn.appendChild(document.createTextNode(chunk));
    }
    const transcript = root.querySelector("#transcript");
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }
  function rerenderMessageInDom(messageId) {
    const session = state.activeSession;
    if (!session) return;
    const message = session.messages.find((m) => m.id === messageId);
    if (!message) return;
    const turn = root.querySelector(`.turn[data-message-id="${cssAttr(messageId)}"]`);
    if (!turn) return;
    turn.replaceWith(renderMessage(message));
  }
  function cssAttr(id) {
    return id.replace(/"/g, '\\"');
  }
  function handleMessage(msg) {
    switch (msg.type) {
      case "init":
        state.settings = msg.settings;
        state.sessions = msg.sessions;
        state.activeSession = msg.activeSession;
        state.activeSessionId = msg.activeSessionId;
        state.project = msg.project;
        state.catalog = msg.catalog;
        state.backendStatus = msg.backendStatus;
        state.apiOrigin = msg.apiOrigin;
        state.streaming = false;
        render();
        break;
      case "settings":
        state.settings = msg.settings;
        renderComposer();
        if (state.settingsOpen) renderSettings();
        break;
      case "catalog":
        state.catalog = msg.catalog;
        state.backendStatus = msg.backendStatus;
        renderComposer();
        renderBackendBanner();
        if (state.modelPickerOpen) renderModelPicker();
        if (state.agentPickerOpen) renderAgentPicker();
        break;
      case "openSettings":
        state.settingsOpen = true;
        applySettings();
        break;
      case "sessions":
        state.sessions = msg.sessions;
        state.activeSessionId = msg.activeSessionId;
        renderSidebar();
        break;
      case "session":
        state.activeSession = msg.session;
        state.activeSessionId = msg.session.id;
        state.streaming = msg.session.messages.some((m) => m.status === "streaming");
        renderHeader();
        renderTranscript();
        renderComposer();
        break;
      case "messageStart":
        if (state.activeSession && state.activeSession.id === msg.sessionId) {
          const m = state.activeSession.messages.find((x) => x.id === msg.messageId);
          if (m) {
            m.startedAt = msg.startedAt;
            m.status = "streaming";
            state.streaming = true;
            state.expandedTimelines.add(msg.messageId);
            renderTranscript();
            renderComposer();
          }
        }
        break;
      case "messageAppend":
        if (state.activeSession && state.activeSession.id === msg.sessionId) {
          const m = state.activeSession.messages.find((x) => x.id === msg.messageId);
          if (m) {
            m.content += msg.chunk;
            m.status = "streaming";
            state.streaming = true;
            appendChunkInDom(msg.messageId, msg.chunk);
            updateAssistantMetaInDom(msg.messageId);
            renderComposer();
          }
        }
        break;
      case "toolUpdate":
        if (state.activeSession && state.activeSession.id === msg.sessionId) {
          const m = state.activeSession.messages.find((x) => x.id === msg.messageId);
          if (m) {
            m.tools = upsertTool(m.tools, msg.entry);
            m.editedFiles = msg.editedFiles;
            m.status = "streaming";
            state.streaming = true;
            state.expandedTimelines.add(msg.messageId);
            if (msg.editedFiles.length > 0) state.expandedEditCards.add(msg.messageId);
            updateAssistantMetaInDom(msg.messageId);
          }
        }
        break;
      case "messageComplete":
        if (state.activeSession && state.activeSession.id === msg.sessionId) {
          const m = state.activeSession.messages.find((x) => x.id === msg.messageId);
          if (m) {
            m.status = "complete";
            m.completedAt = msg.completedAt;
          }
          state.expandedTimelines.delete(msg.messageId);
          if (m) rerenderMessageInDom(msg.messageId);
          state.streaming = false;
          renderComposer();
        }
        break;
      case "messageError":
        if (state.activeSession && state.activeSession.id === msg.sessionId) {
          const m = state.activeSession.messages.find((x) => x.id === msg.messageId);
          if (m) {
            m.status = "error";
            m.error = msg.error;
            m.completedAt = msg.completedAt;
          }
          state.expandedTimelines.delete(msg.messageId);
          if (m) rerenderMessageInDom(msg.messageId);
          state.streaming = false;
          renderComposer();
        }
        break;
      case "log":
        console.warn("[chatllm]", msg.message);
        break;
    }
  }
  window.addEventListener("message", (event) => handleMessage(event.data));
  send({ type: "ready" });
})();
//# sourceMappingURL=chat.js.map
