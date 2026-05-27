import mermaid from "mermaid";

mermaid.initialize({
  startOnLoad: false,
  theme: "default",
  securityLevel: "strict",
  fontFamily: "var(--vscode-font-family)",
});

let counter = 0;

export async function render(source: string): Promise<string> {
  counter += 1;
  const id = `chatllm-mermaid-${counter}`;
  const { svg } = await mermaid.render(id, source);
  return svg;
}

declare global {
  interface Window {
    ChatllmMermaid: {
      render: (source: string) => Promise<string>;
    };
  }
}
