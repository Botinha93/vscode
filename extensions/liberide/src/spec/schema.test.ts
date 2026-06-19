import { describe, expect, test } from "bun:test";
import {
  extractSectionIds,
  parseBlockerItems,
  parseDocumentationItems,
  parseFrontmatter,
  parseTaskContract,
} from "./schema";

const fakeUri = { toString: () => "mem:task" } as unknown as Parameters<typeof parseTaskContract>[1];

describe("parseFrontmatter", () => {
  test("parses scalars, inline arrays, block lists, and block strings", () => {
    const raw = [
      "---",
      "id: T-1",
      "title: Do the thing",
      "depends_on: [T-0, T-2]",
      "acceptance:",
      "  - first",
      "  - second",
      "architecture_hints: |",
      "  line one",
      "  line two",
      "---",
      "Body text here.",
    ].join("\n");
    const { data, body } = parseFrontmatter(raw);
    expect(data.id).toBe("T-1");
    expect(data.depends_on).toEqual(["T-0", "T-2"]);
    expect(data.acceptance).toEqual(["first", "second"]);
    expect(data.architecture_hints).toBe("line one\nline two");
    expect(body.trim()).toBe("Body text here.");
  });

  test("returns the whole input as body when no frontmatter", () => {
    expect(parseFrontmatter("no fm").body).toBe("no fm");
  });
});

describe("parseTaskContract", () => {
  test("extracts a task; rejects when id/title missing", () => {
    const raw = "---\nid: T-9\ntitle: Build it\nstatus: ready\ndepends_on: [T-1]\n---\nimplement";
    const task = parseTaskContract("feat", fakeUri, raw);
    expect(task?.id).toBe("T-9");
    expect(task?.status).toBe("ready");
    expect(task?.dependsOn).toEqual(["T-1"]);
    expect(task?.body).toBe("implement");
    expect(parseTaskContract("feat", fakeUri, "---\ntitle: no id\n---\n")).toBeUndefined();
  });
});

describe("extractSectionIds", () => {
  test("collects ## <prefix>-N headings", () => {
    const md = "# Requirements\n## R-1 First\ntext\n## R-2 Second\n## D-1 ignore";
    expect(extractSectionIds(md, "R")).toEqual(["R-1", "R-2"]);
  });
});

describe("parseDocumentationItems", () => {
  test("parses id/title and optional target", () => {
    const md = "# Documentation\n## DOC-1 Readme update\ntarget: README.md\n## DOC-2 API docs";
    expect(parseDocumentationItems(md)).toEqual([
      { id: "DOC-1", title: "Readme update", target: "README.md" },
      { id: "DOC-2", title: "API docs" },
    ]);
  });
});

describe("parseBlockerItems", () => {
  test("parses severity tag, title, and detail; defaults to hard", () => {
    const md = "# Blockers\n## BLK-1 [hard] Needs schema\nmigration required\n## BLK-2 [soft] Maybe flaky\n## BLK-3 No tag here";
    const items = parseBlockerItems(md);
    expect(items[0]).toEqual({ id: "BLK-1", title: "Needs schema", severity: "hard", detail: "migration required" });
    expect(items[1]).toEqual({ id: "BLK-2", title: "Maybe flaky", severity: "soft" });
    expect(items[2]).toEqual({ id: "BLK-3", title: "No tag here", severity: "hard" });
  });
});
