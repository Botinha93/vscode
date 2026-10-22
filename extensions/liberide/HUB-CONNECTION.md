# Hub managed LiberIDE connection

NexusHub can install or provision the LiberIDE extension and configure the
backend URL in the VS Code profile it launches. Set the URL with VS Code's
normal settings mechanism; it contains no credential:

```json
{
  "liberide.apiOrigin": "https://liberide.example.test"
}
```

The value must be an absolute `http://` or `https://` URL. A server mounted at a
path prefix is supported, for example `https://example.test/liberide`. URL
credentials, query strings, and fragments are rejected. The extension removes
trailing slashes and uses the resulting base for its `/api/...` requests and
WebSocket endpoints.

The Hub installer should write this setting into the `User/settings.json` file
inside the same `--user-data-dir` passed to the VS Code process. This keeps the
server choice attached to the Hub-managed installation/profile. The extension
also reads the setting when it activates, so provision the file before first
launch. A later settings change is picked up by the extension for subsequent
API requests; reload the VS Code window to reconnect long-lived streams to the
new server.

Server origin precedence is:

1. `LIBERIDE_API_ORIGIN` or `CHATLLM_API_ORIGIN` from the VS Code launch
   environment.
2. `apiOrigin` in the active `libervox-integration.json` (including a server
   written by the existing machine pairing flow).
3. The validated `liberide.apiOrigin` setting.

Authentication remains separate from this setting. The Hub must use the
existing NexusID sign-in/pairing or integration-file flow to provide a token;
it must not put a token in VS Code settings. Standalone launches continue to
work with the existing environment variables, integration file, or pairing
command.

## Build and package

From the Chatllm repository root, the VS Code source is the `vscode` submodule.
Install extension dependencies and build its four bundles with the commands
defined by `vscode/extensions/liberide/package.json`:

```bash
cd vscode/extensions/liberide
npm install
npm run build
```

`npm run build` invokes `node esbuild.mjs`. It emits `extension.js` plus the
chat, pipeline, and Mermaid webview bundles in `media/`. Package the built-in
extension with the bundled VS Code distribution; it is private and is not
published to the Marketplace.
