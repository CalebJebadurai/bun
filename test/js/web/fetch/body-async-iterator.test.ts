import { expect, test } from "bun:test";
import { bunEnv, bunExe } from "harness";

test("Response.bytes() with async iterable body does not crash with null deref", async () => {
  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `
      function* gen() {}
      const body = {};
      body[Symbol.asyncIterator] = () => gen();
      const resp = new Response(body);
      try { resp.bytes(); } catch {}
      try { resp.bytes(); } catch(e) { console.log(e.message); }
      process.exit(0);
      `,
    ],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

  expect(stdout).not.toContain("null is not an object");
  expect(exitCode).toBe(0);
});

test("Response.arrayBuffer() with async iterable body does not crash with null deref", async () => {
  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `
      function* gen() {}
      const body = {};
      body[Symbol.asyncIterator] = () => gen();
      const resp = new Response(body);
      try { resp.arrayBuffer(); } catch {}
      try { resp.arrayBuffer(); } catch(e) { console.log(e.message); }
      process.exit(0);
      `,
    ],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

  expect(stdout).not.toContain("null is not an object");
  expect(exitCode).toBe(0);
});

// The one-shot ArrayBufferSink behind bytes()/arrayBuffer() must settle its result before it
// runs the source's close() hook. For an async iterable body that hook calls iterator.return(),
// and a throw from it used to leave the promise pending forever.
function iterableWithThrowingReturn(log: string[]) {
  return {
    [Symbol.asyncIterator]() {
      let n = 0;
      return {
        async next() {
          log.push(`next${n}`);
          return n++ < 2 ? { value: new Uint8Array(3).fill(n), done: false } : { done: true, value: undefined };
        },
        return(value: unknown) {
          log.push("return");
          throw new RangeError("ret");
          return { done: true, value };
        },
      };
    },
  };
}

for (const method of ["bytes", "arrayBuffer", "text", "blob"] as const) {
  test(`Response.${method}() settles when the async iterator's return() throws`, async () => {
    const log: string[] = [];
    const result = await new Response(iterableWithThrowingReturn(log) as any)[method]();
    const bytes =
      result instanceof Blob
        ? new Uint8Array(await result.arrayBuffer())
        : typeof result === "string"
          ? new TextEncoder().encode(result)
          : new Uint8Array(result as ArrayBuffer);
    expect(Array.from(bytes)).toEqual([1, 1, 1, 2, 2, 2]);
    expect(log).toEqual(["next0", "next1", "next2", "return"]);
  }, 5000);
}
