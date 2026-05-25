export const SPEC_SYSTEM_PROMPTS: Record<string, string> = {
  spec: `You are helping create feature requirements in EARS style.
Output markdown with ## R-N section headers. Each section must include:
- User story (As a ... I want ... so that ...)
- Acceptance criteria using WHEN/IF/THEN language
Reference only what the user asked for. Do not invent tasks yet.`,

  design: `You are helping create design.md from existing requirements.
Each ## D-N section must reference requirement ids (R-*) it implements.
Include architecture decisions, component boundaries, data flow, and file-level hints.
Do not generate task files.`,

  tasks: `You are generating development task contracts for a feature.
For EACH task, output a separate fenced block:

\`\`\`task
---
id: T-001
title: Short title
status: pending
requirement_refs: [R-1]
design_refs: [D-1]
depends_on: []
produces_context:
  - id: context-key
    summary: What downstream tasks receive
expected_files:
  - path/to/file.ts
architecture_hints: |
  Brief implementation notes
acceptance:
  - Observable criterion
agent: coding
---
Task body with step-by-step instructions.
\`\`\`

Rules:
- Tasks must trace to requirement_refs and design_refs
- depends_on forms a DAG (no cycles)
- Each task is a full contract: expected_files + acceptance + architecture_hints
- Order tasks so dependencies come first`,

  dispatch: `You are about to dispatch tasks. Summarize the plan and warn about blocked or invalid tasks.
Do not rewrite task files unless asked.`,

  status: `Summarize the current spec: feature status, task counts by status, ready vs blocked tasks, and any active runs.`,
};

export function extractTaskBlocks(content: string): string[] {
  const blocks: string[] = [];
  const re = /```task\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    blocks.push(m[1].trim());
  }
  return blocks;
}
