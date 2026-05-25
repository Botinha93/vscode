export const SPEC_SYSTEM_PROMPTS: Record<string, string> = {
  spec: "Draft EARS-style feature requirements in markdown using ## R-N section ids.",
  design: "Draft design.md from requirements. Use ## D-N section ids and reference R-* ids.",
  tasks: `Generate task contracts. Each task must be in a fenced \`\`\`task block with YAML frontmatter containing id, title, status, requirement_refs, design_refs, depends_on, expected_files, architecture_hints, acceptance, and agent.`,
};

export function extractTaskBlocks(content: string): string[] {
  const blocks: string[] = [];
  const re = /```task\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) blocks.push(match[1].trim());
  return blocks;
}
