import { describe, expect, test } from "bun:test";
import { tempDir } from "harness";
import path from "node:path";
import { pathToFileURL } from "node:url";

describe("import.meta.resolve with URL instance parent (#41318)", () => {
  test("resolves relative specifier with URL parent identical to string parent", () => {
    const parentUrl = new URL("./sub/dir/mod.mjs", import.meta.url);
    const resolvedFromUrl = import.meta.resolve("./sibling.mjs", parentUrl);
    const resolvedFromString = import.meta.resolve("./sibling.mjs", parentUrl.href);

    expect(resolvedFromUrl).toBe(resolvedFromString);
    expect(resolvedFromUrl).toBe(new URL("./sub/dir/sibling.mjs", import.meta.url).href);
  });

  test("resolves parent directory specifier (..) with URL parent", () => {
    const parentUrl = new URL("./sub/dir/mod.mjs", import.meta.url);
    const resolvedFromUrl = import.meta.resolve("../parent-sibling.mjs", parentUrl);
    const resolvedFromString = import.meta.resolve("../parent-sibling.mjs", parentUrl.href);

    expect(resolvedFromUrl).toBe(resolvedFromString);
    expect(resolvedFromUrl).toBe(new URL("./sub/parent-sibling.mjs", import.meta.url).href);
  });

  test("undefined and null fall back to caller base URL", () => {
    const resolvedDefault = import.meta.resolve("./sibling.mjs");
    const resolvedUndefined = import.meta.resolve("./sibling.mjs", undefined);
    const resolvedNull = import.meta.resolve("./sibling.mjs", null);

    expect(resolvedUndefined).toBe(resolvedDefault);
    expect(resolvedNull).toBe(resolvedDefault);
    expect(resolvedDefault).toBe(new URL("./sibling.mjs", import.meta.url).href);
  });

  test("resolves relative specifier against non-file URL parent", () => {
    expect(import.meta.resolve("./sibling.mjs", new URL("https://example.com/sub/mod.mjs"))).toBe(
      "https://example.com/sub/sibling.mjs",
    );
  });

  test("import.meta.resolve(bare specifier, URL parent) searches node_modules from parent with spaces", () => {
    using tmp = tempDir("import-meta-resolve url-parent", {
      "sub/node_modules/import-meta-resolve-url-parent-pkg/package.json": JSON.stringify({
        name: "import-meta-resolve-url-parent-pkg",
        version: "1.0.0",
        main: "index.js",
      }),
      "sub/node_modules/import-meta-resolve-url-parent-pkg/index.js": "module.exports = 1;",
      "sub/sibling.mjs": "export default 1;",
    });
    const parent = pathToFileURL(path.join(String(tmp), "sub", "mod.mjs"));
    const resolvedPath = path.join(String(tmp), "sub", "node_modules", "import-meta-resolve-url-parent-pkg", "index.js");
    expect(import.meta.resolve("import-meta-resolve-url-parent-pkg", parent)).toBe(pathToFileURL(resolvedPath).href);
    expect(import.meta.resolve("import-meta-resolve-url-parent-pkg", parent.href)).toBe(pathToFileURL(resolvedPath).href);
    expect(import.meta.resolveSync("import-meta-resolve-url-parent-pkg", parent)).toBe(resolvedPath);
    expect(import.meta.resolveSync("import-meta-resolve-url-parent-pkg", parent.href)).toBe(resolvedPath);
    expect(import.meta.resolveSync("import-meta-resolve-url-parent-pkg", { paths: [parent.href] })).toBe(resolvedPath);
    expect(import.meta.resolveSync("./sibling.mjs", parent)).toBe(path.join(String(tmp), "sub", "sibling.mjs"));
    expect(import.meta.resolveSync("./sibling.mjs", parent.href)).toBe(path.join(String(tmp), "sub", "sibling.mjs"));
  });

  test("import.meta.resolveSync accepts URL instance and paths array with URL", () => {
    expect(import.meta.resolveSync("./" + import.meta.file, new URL(import.meta.url))).toBe(import.meta.path);
    expect(import.meta.resolveSync("./" + import.meta.file, { paths: [new URL(import.meta.url)] })).toBe(
      import.meta.path,
    );
    expect(() => import.meta.resolveSync("./does-not-exist.ts", new URL(import.meta.url))).toThrow();
  });

  describe("parentURL argument validation", () => {
    test.each([
      ["number", 42, "type number (42)"],
      ["boolean true", true, "type boolean (true)"],
      ["boolean false", false, "type boolean (false)"],
      ["bigint", 100n, "type bigint (100n)"],
      ["empty object", {}, "an instance of Object"],
      ["symbol", Symbol("x"), "type symbol (Symbol(x))"],
      ["function", () => {}, "function "],
    ])("throws ERR_INVALID_ARG_TYPE for a %s parent", (_label, invalidValue, receivedSnippet) => {
      let error: any = null;
      try {
        // @ts-ignore
        import.meta.resolve("./sibling.mjs", invalidValue);
      } catch (e: any) {
        error = { code: e.code, message: e.message };
      }
      expect(error).not.toBeNull();
      expect(error.code).toBe("ERR_INVALID_ARG_TYPE");
      expect(error.message).toContain('The "parentURL" argument must be of type string or an instance of URL.');
      expect(error.message).toContain(receivedSnippet);
    });

    test("supports object with paths array", () => {
      const testFile = path.join(import.meta.dir, "sub", "mod.mjs");
      const resolved = import.meta.resolve("./sibling.mjs", { paths: [testFile] });
      expect(resolved).toBe(new URL("./sub/sibling.mjs", import.meta.url).href);

      const resolvedWithUrl = import.meta.resolve("./sibling.mjs", { paths: [pathToFileURL(testFile)] });
      expect(resolvedWithUrl).toBe(new URL("./sub/sibling.mjs", import.meta.url).href);
    });
  });
});
