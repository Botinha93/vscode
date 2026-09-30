import { afterAll, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { createdTerminals, vscodeMock } from "./vscode-mock";

mock.module("vscode", () => vscodeMock);
const terminals = await import("../src/terminal/agent-terminals");
afterAll(() => terminals.disposeAgentTerminals());

const posix = process.platform !== "win32";

describe.skipIf(!posix)("agent terminal sessions", () => {
  test("send returns the command's output and read only returns new output", async () => {
    const { sessionId } = terminals.openAgentTerminal({ name: "test", cwd: tmpdir() });
    const first = await terminals.sendToAgentTerminal(sessionId, "echo hello-session", { addNewline: true });
    expect(first.output).toContain("hello-session");
    expect(first.running).toBe(true);

    const second = await terminals.sendToAgentTerminal(sessionId, "echo second", { addNewline: true });
    expect(second.output).toContain("second");
    expect(second.output).not.toContain("hello-session");

    expect(terminals.readAgentTerminal(sessionId, false).output).toBe("");
    expect(terminals.readAgentTerminal(sessionId, true).output).toContain("hello-session");

    // The user sees the agent's input and the output in the terminal tab.
    const tab = createdTerminals.find((terminal) => terminal.name === "test")!;
    expect(tab.written).toContain("echo hello-session");
    expect(tab.written).toContain("hello-session\r\n");
    terminals.closeAgentTerminal(sessionId);
  });

  test("state carries across sends (it is one shell)", async () => {
    const { sessionId } = terminals.openAgentTerminal({ name: "state", cwd: tmpdir() });
    await terminals.sendToAgentTerminal(sessionId, "export LIBERIDE_X=42", { addNewline: true, waitMs: 300 });
    const result = await terminals.sendToAgentTerminal(sessionId, "echo value=$LIBERIDE_X", { addNewline: true });
    expect(result.output).toContain("value=42");
    terminals.closeAgentTerminal(sessionId);
  });

  test("reports the exit code when the shell ends, and unknown sessions fail clearly", async () => {
    const { sessionId } = terminals.openAgentTerminal({ name: "exit", cwd: tmpdir() });
    const result = await terminals.sendToAgentTerminal(sessionId, "exit 3", { addNewline: true, waitMs: 5_000 });
    expect(result.running).toBe(false);
    expect(result.exitCode).toBe(3);
    terminals.closeAgentTerminal(sessionId);
    expect(() => terminals.readAgentTerminal(sessionId, false)).toThrow("Unknown terminal session");
  });
});
