# LiberIDE — VS Code extension

The bundled `liberide` extension is the IDE half of the [LiberVox suite](../../../README.md) under the Nexus product family. It embeds the chat, pipeline, specs, tasks, and agent runs surfaces directly in the VS Code workspace and talks to the local VoxChat API.

This extension is preinstalled in the bundled VS Code fork that ships with the LiberVox desktop app. It is not published to the Marketplace.

## Features

- **Chat** — Full VoxChat chat in the secondary sidebar, including model picker, RAG toggle, tool calling, and agent mode.
- **Pipeline view** — Visualize the active execution graph (PLAN → IMPLEMENT → VERIFY → REPAIR, etc.).
- **Specs & Tasks** — Scaffold spec features, browse tasks, mark tasks ready, and dispatch them to agents.
- **Agent Runs** — Inspect durable background agent runs.
- **GitHub Copilot models** — When Copilot is signed in, its models show up in the LiberIDE chat picker and run through VS Code's Language Model API. Tool calls are relayed to the VoxChat backend so the same orchestrator, MCP, and IDE tools execute as for any other provider. See [GitHub Copilot integration](../../../docs/github-copilot-integration.md) for the full design.

## Commands

| Command | Title |
|---|---|
| `liberide.openChat` | Open LiberIDE Chat |
| `liberide.newChat` | New Chat |
| `liberide.openSettings` | Open LiberIDE Settings |
| `liberide.openPipeline` | Open LiberIDE Pipeline |
| `liberide.scaffoldFeature` | Scaffold Spec Feature |
| `liberide.setActiveFeature` | Set Active Spec Feature |
| `liberide.openTask` | Open Task Contract |
| `liberide.runTask` | Run Task |
| `liberide.markTaskReady` | Mark Task Ready |
| `liberide.dispatchFeature` | Dispatch Feature Tasks |
| `liberide.regenerateTasksIndex` | Regenerate Tasks Index |
| `liberide.cancelRun` | Cancel Active Run |
| `liberide.refreshSpecs` | Refresh Specs |
| `liberide.refreshTasks` | Refresh Tasks |
| `liberide.refreshRuns` | Refresh Runs |

## Settings

| Setting | Default | Description |
|---|---|---|
| `liberide.modelSelection` | `manual` | Local override for model selection mode. `auto` lets the backend upgrade models based on the request. |
| `liberide.chatMode` | `normal` | Default chat mode for new chats (`normal` or `agent`). |
| `liberide.useRag` | `false` | Default for RAG on new chats. |
| `liberide.toolsEnabled` | `true` | Default for tool calling on new chats. |
| `liberide.systemPrompt` | `""` | Optional system prompt appended to every LiberIDE chat request. |
| `liberide.copilot.enabled` | `false` | Re-enable the bundled Copilot Chat UI. Leave off while using LiberIDE's chat surface. |
| `liberide.copilot.modelsEnabled` | `true` | Enable Copilot models via VS Code's Language Model API (`vscode.lm`). Requires the Copilot model provider to be installed. |

### GitHub Copilot

Copilot models can run on two paths, controlled per-setting:

- **In-IDE (`liberide.copilot.modelsEnabled = true`)** — Uses `vscode.lm.selectChatModels({ vendor: "copilot" })`. The Copilot token stays in VS Code; tool calls are relayed to the VoxChat backend via `POST /api/tools/invoke`. This is the default.
- **Cloud / linked account** — Open the LiberIDE chat panel's **Integrations** section and click **Sign in to GitHub for Copilot**. The granted access token is sent to `POST /api/copilot/link/ide`, so the same Nexus user can use Copilot from the VoxChat web app and from LiberIDE. The backend then talks to `api.githubcopilot.com` over OpenAI-compatible chat completions and runs the full VoxChat orchestrator on top.

The native Copilot Chat UI is hidden while `liberide.copilot.enabled = false`. The bundled `copilot-chat` extension is kept installed because it provides the `vendor: "copilot"` model provider that VS Code exposes to other extensions.

For setup, OAuth configuration, schema, capability inference, and end-to-end flows, see [`docs/github-copilot-integration.md`](../../../docs/github-copilot-integration.md).

## How it connects to the API

The launcher injects `LIBERIDE_API_ORIGIN` and `LIBERIDE_AUTH_TOKEN` environment variables when starting the bundled VS Code Electron window, so the extension can talk to the local VoxChat API without any user configuration.

## Building

```bash
cd vscode/extensions/liberide
npm install
npm run build
```

The build emits:

- `extension.js` — the VS Code extension host bundle.
- `media/chat.js`, `media/pipeline.js`, `media/mermaid.js` — webview bundles.
- Source maps next to each output.
