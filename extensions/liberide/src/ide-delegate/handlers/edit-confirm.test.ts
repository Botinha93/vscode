import { describe, expect, test } from "bun:test";
import { shouldConfirmEdit, summarizeEdit } from "./edit-confirm";

const singleFile = { changes: { "a.ts": [{ range: {}, newText: "x" }] } };
const multiFile = { changes: { "a.ts": [{}], "b.ts": [{}] } };
const withDelete = { documentChanges: [{ kind: "delete", path: "gone.ts" }] };
const withCreate = { documentChanges: [{ kind: "create", path: "new.ts" }] };
const textViaDocChanges = { documentChanges: [{ path: "a.ts", textEdits: [{}] }] };

describe("summarizeEdit", () => {
  test("counts distinct files across changes and documentChanges", () => {
    expect(summarizeEdit(singleFile)).toEqual({ fileCount: 1, hasDestructive: false });
    expect(summarizeEdit(multiFile).fileCount).toBe(2);
    expect(summarizeEdit(textViaDocChanges)).toEqual({ fileCount: 1, hasDestructive: false });
  });

  test("flags create/rename/delete as destructive", () => {
    expect(summarizeEdit(withDelete).hasDestructive).toBe(true);
    expect(summarizeEdit(withCreate).hasDestructive).toBe(true);
    expect(summarizeEdit({ documentChanges: [{ kind: "rename", oldPath: "a", newPath: "b" }] })).toEqual({
      fileCount: 2,
      hasDestructive: true,
    });
  });
});

describe("shouldConfirmEdit", () => {
  test("off never confirms", () => {
    expect(shouldConfirmEdit(multiFile, "off")).toBe(false);
    expect(shouldConfirmEdit(withDelete, "off")).toBe(false);
  });

  test("always confirms everything", () => {
    expect(shouldConfirmEdit(singleFile, "always")).toBe(true);
  });

  test("multiFileAndDeletes confirms only multi-file or destructive edits", () => {
    expect(shouldConfirmEdit(singleFile, "multiFileAndDeletes")).toBe(false);
    expect(shouldConfirmEdit(multiFile, "multiFileAndDeletes")).toBe(true);
    expect(shouldConfirmEdit(withDelete, "multiFileAndDeletes")).toBe(true);
    expect(shouldConfirmEdit(withCreate, "multiFileAndDeletes")).toBe(true);
  });
});
