# Chatllm — VS Code extension

The bundled `chatllm` extension is the IDE half of [Chatllm](../../../README.md). It embeds the chat, pipeline, specs, tasks, and agent runs surfaces directly in the VS Code workspace and talks to the local Chatllm API.

This extension is preinstalled in the bundled VS Code fork that ships with the Chatllm desktop app. It is not published to the Marketplace.

## Features

- **Chat** — Full Chatllm chat in the secondary sidebar, including model picker, RAG toggle, tool calling, and agent mode.
- **Pipeline view** — Visualize the active execution graph (PLAN → IMPLEMENT → VERIFY → REPAIR, etc.).
- **Specs & Tasks** — Scaffold spec features, browse tasks, mark tasks ready, and dispatch them to agents.
- **Agent Runs** — Inspect durable background agent runs.
- **GitHub Copilot models** — When Copilot is signed in, its models show up in the Chatllm chat picker and run through VS Code's Language Model API. Tool calls are relayed to the Chatllm backend so the same orchestrator, MCP, and IDE tools execute as for any other provider. See [GitHub Copilot integration](../../../docs/github-copilot-integration.md) for the full design.

## Commands

| Command | Title |
|---|---|
| `chatllm.openChat` | Open Chatllm Chat |
| `chatllm.newChat` | New Chat |
| `chatllm.openSettings` | Open Chatllm Settings |
| `chatllm.openPipeline` | Open Chatllm Pipeline |
| `chatllm.scaffoldFeature` | Scaffold Spec Feature |
| `chatllm.setActiveFeature` | Set Active Spec Feature |
| `chatllm.openTask` | Open Task Contract |
| `chatllm.runTask` | Run Task |
| `chatllm.markTaskReady` | Mark Task Ready |
| `chatllm.dispatchFeature` | Dispatch Feature Tasks |
| `chatllm.regenerateTasksIndex` | Regenerate Tasks Index |
| `chatllm.cancelRun` | Cancel Active Run |
| `chatllm.refreshSpecs` | Refresh Specs |
| `chatllm.refreshTasks` | Refresh Tasks |
| `chatllm.refreshRuns` | Refresh Runs |

## Settings

| Setting | Default | Description |
|---|---|---|
| `chatllm.modelSelection` | `manual` | Local override for model selection mode. `auto` lets the backend upgrade models based on the request. |
| `chatllm.chatMode` | `normal` | Default chat mode for new chats (`normal` or `agent`). |
| `chatllm.useRag` | `false` | Default for RAG on new chats. |
| `chatllm.toolsEnabled` | `true` | Default for tool calling on new chats. |
| `chatllm.systemPrompt` | `""` | Optional system prompt appended to every Chatllm chat request. |
| `chatllm.copilot.enabled` | `false` | Re-enable the bundled Copilot Chat UI. Leave off while using Chatllm's chat surface. |
| `chatllm.copilot.modelsEnabled` | `true` | Enable Copilot models via VS Code's Language Model API (`vscode.lm`). Requires the Copilot model provider to be installed. |

### GitHub Copilot

Copilot models can run on two paths, controlled per-setting:

- **In-IDE (`chatllm.copilot.modelsEnabled = true`)** — Uses `vscode.lm.selectChatModels({ vendor: "copilot" })`. The Copilot token stays in VS Code; tool calls are relayed to the Chatllm backend via `POST /api/tools/invoke`. This is the default.
- **Cloud / linked account** — Open the Chatllm chat panel's **Integrations** section and click **Sign in to GitHub for Copilot**. The granted access token is sent to `POST /api/copilot/link/ide`, so the same Chatllm user can use Copilot from the web app and the IDE. The backend then talks to `api.githubcopilot.com` over OpenAI-compatible chat completions and runs the full Chatllm orchestrator on top.

The native Copilot Chat UI is hidden while `chatllm.copilot.enabled = false`. The bundled `copilot-chat` extension is kept installed because it provides the `vendor: "copilot"` model provider that VS Code exposes to other extensions.

For setup, OAuth configuration, schema, capability inference, and end-to-end flows, see [`docs/github-copilot-integration.md`](../../../docs/github-copilot-integration.md).

## How it connects to the API

The launcher injects `CHATLLM_API_ORIGIN` and `CHATLLM_AUTH_TOKEN` environment variables when starting the bundled VS Code Electron window, so the extension can talk to the local Chatllm API without any user configuration.

## Building

```bash
cd vscode/extensions/chatllm
npm install
npm run build
```

The build emits:

- `extension.js` — the VS Code extension host bundle.
- `media/chat.js`, `media/pipeline.js`, `media/mermaid.js` — webview bundles.
- Source maps next to each output.
