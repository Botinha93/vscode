import { beforeEach, describe, expect, mock, test } from "bun:test";
import { LanguageModelTextPart, LanguageModelToolCallPart, LanguageModelToolResultPart, lm, vscodeMock } from "./vscode-mock";

const invoked: Array<{ name: string; arguments: Record<string, unknown> }> = [];
let invokeResponse: () => Response = () => Response.json({ result: "file contents" });

mock.module("vscode", () => vscodeMock);
mock.module("../src/api", () => ({
  apiFetch: async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/tools/catalog")) {
      return Response.json({
        entries: [
          { name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, execution: { sideEffect: "read" } },
          { name: "delegate", description: "Delegate", inputSchema: { type: "object" }, execution: { sideEffect: "control" } },
        ],
      });
    }
    invoked.push(JSON.parse(String(init?.body)));
    return invokeResponse();
  },
}));
const { streamCopilotChat } = await import("../src/chat/copilot-lm");

type Round = Array<LanguageModelTextPart | LanguageModelToolCallPart>;

/** A fake Copilot model that replays scripted rounds and records each request. */
function scriptedModel(rounds: Round[]) {
  const requests: Array<{ messages: Array<{ role: string; content: unknown }>; options: { tools?: Array<{ name: string; inputSchema: unknown }> } }> = [];
  lm.models = [{
    id: "gpt-test",
    vendor: "copilot",
    family: "gpt",
    maxInputTokens: 64_000,
    sendRequest: async (messages: Array<{ role: string; content: unknown }>, options: { tools?: Array<{ name: string; inputSchema: unknown }> }) => {
      requests.push({ messages: [...messages], options });
      const parts = rounds.shift() ?? [new LanguageModelTextPart("(no more rounds)")];
      return { stream: (async function* () { yield* parts; })() };
    },
  }];
  return requests;
}

const base = { modelId: "gpt-test", history: [], prompt: "read a.ts", toolsEnabled: true, onToken: () => undefined, onToolEvent: () => undefined };

describe("Copilot LM bridge", () => {
  beforeEach(() => {
    invoked.length = 0;
    invokeResponse = () => Response.json({ result: "file contents" });
  });

  test("streams text, runs tool calls through the backend and continues the loop", async () => {
    const requests = scriptedModel([
      [new LanguageModelTextPart("Let me look. "), new LanguageModelToolCallPart("c1", "read_file", { path: "a.ts" })],
      [new LanguageModelTextPart("It exports a.")],
    ]);
    const tokens: string[] = [];
    const result = await streamCopilotChat({ ...base, onToken: (token) => tokens.push(token) });

    expect(result.content).toBe("Let me look. It exports a.");
    expect(tokens.join("")).toBe(result.content);
    expect(invoked).toEqual([expect.objectContaining({ name: "read_file", arguments: { path: "a.ts" } })]);
    // Real catalog schemas, minus server-loop-only tools.
    expect(requests[0]!.options.tools!.map((tool) => tool.name)).toEqual(["read_file"]);
    expect(requests[0]!.options.tools![0]!.inputSchema).toMatchObject({ required: ["path"] });
    // The second request carries the call and its matched result.
    const followUp = requests[1]!.messages.slice(-2);
    expect(followUp[0]!.role).toBe("assistant");
    const resultPart = (followUp[1]!.content as LanguageModelToolResultPart[])[0]!;
    expect(resultPart.callId).toBe("c1");
    expect((resultPart.content[0] as LanguageModelTextPart).value).toBe("file contents");
  });

  test("a failing tool is returned to the model instead of aborting the turn", async () => {
    invokeResponse = () => new Response("Unknown V2 tool", { status: 400 });
    scriptedModel([
      [new LanguageModelToolCallPart("c1", "read_file", { path: "a.ts" })],
      [new LanguageModelTextPart("Could not read it.")],
    ]);
    const events: Array<{ result?: unknown }> = [];
    const result = await streamCopilotChat({ ...base, onToolEvent: (event) => events.push(event) });
    expect(result.content).toBe("Could not read it.");
    expect(String(events.at(-1)?.result)).toContain("Unknown V2 tool");
  });

  test("stops offering tools on the last round so the model must answer", async () => {
    const endless = Array.from({ length: 20 }, (_, i) => [new LanguageModelToolCallPart(`c${i}`, "read_file", { path: "a.ts" })] as Round);
    const requests = scriptedModel(endless);
    await streamCopilotChat(base);
    expect(requests.length).toBe(12);
    expect(requests.at(-1)!.options.tools).toBeUndefined();
  });
});
