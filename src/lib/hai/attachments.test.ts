import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { buildModelText, fence, looksBinary, readZip } from "./attachments";

describe("zip attachments", () => {
  it("reads code files and leaves out images, binaries and dependency folders", () => {
    const zip = zipSync({
      "src/app.ts": strToU8("export const a = 1;"),
      "README.md": strToU8("# Hello"),
      "logo.png": new Uint8Array([137, 80, 78, 71, 0, 1]),
      "data.bin": new Uint8Array([1, 0, 2, 3]),
      "node_modules/x/index.js": strToU8("ignored"),
    });
    const result = readZip(zip, 10_000);
    expect(result.files.map((f) => f.path)).toEqual(["README.md", "src/app.ts"]);
    expect(result.skipped.sort()).toEqual(["data.bin", "logo.png"]);
  });

  it("stops adding files once the text budget is used", () => {
    const zip = zipSync({ "a.txt": strToU8("x".repeat(60)), "b.txt": strToU8("y".repeat(60)) });
    const result = readZip(zip, 100);
    expect(result.files).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });
});

describe("message text for the model", () => {
  it("puts each attached file in a fenced code block with its language", () => {
    const text = buildModelText("fix the bug", [
      { id: "1", kind: "file", name: "main.py", text: "print('hi')", truncated: false },
    ]);
    expect(text).toBe("fix the bug\n\nAttached file `main.py`:\n```python\nprint('hi')\n```");
  });

  it("uses a longer fence when the file itself contains backticks", () => {
    expect(fence("a ``` b", "md").startsWith("````md\n")).toBe(true);
  });

  it("detects binary files by NUL bytes", () => {
    expect(looksBinary(new Uint8Array([65, 0, 66]))).toBe(true);
    expect(looksBinary(strToU8("plain text"))).toBe(false);
  });
});
