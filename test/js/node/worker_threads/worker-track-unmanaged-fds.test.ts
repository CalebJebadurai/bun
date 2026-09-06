import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isWindows, tempDir } from "harness";

// Worker exit must close what the worker left open: raw fs.open/openSync fds
// when trackUnmanagedFds is on (the default; false opts out), and FileHandle fds
// always, as Node's ~FileHandle does. Verified by inode identity so fd-number
// reuse can never fake a verdict. Windows is skipped because workers receive
// uv-tagged fd numbers that don't map 1:1 to parent fds.
describe.concurrent.skipIf(isWindows)("Worker trackUnmanagedFds", () => {
  // Count fds in this process that point at `ino`. Scans the low fd range
  // with fstat instead of /proc/self/fd so it works on macOS too.
  const openFdsSrc = `
    const openFds = ino => {
      let n = 0;
      for (let fd = 0; fd < 1024; fd++) {
        try { if (fs.fstatSync(fd).ino === ino) n++; } catch {}
      }
      return n;
    };
  `;

  async function run(fixture: string, prefix: string) {
    using dir = tempDir(prefix, {});
    await using proc = Bun.spawn({
      cmd: [bunExe(), "-e", fixture],
      env: bunEnv,
      cwd: String(dir),
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return { stderr, out: JSON.parse(stdout || "null"), exitCode };
  }

  async function probe(openHow: "sync" | "async" | "promise", opts: string) {
    // The worker waits for a parent ack before exiting so `during` is always
    // captured while the fd is still live (no race with the exit sweep).
    const worker =
      `const { parentPort, workerData } = require("node:worker_threads");` +
      `const fs = require("node:fs");` +
      `const done = fd => {` +
      `  parentPort.on("message", () => process.exit(0));` +
      `  parentPort.postMessage({ fd });` +
      `};` +
      `if (workerData.openHow === "sync") done(fs.openSync(workerData.target, "r"));` +
      `else if (workerData.openHow === "async") fs.open(workerData.target, "r", (e, fd) => done(fd));` +
      `else fs.promises.open(workerData.target, "r").then(h => { globalThis.KEEP = h; done(h.fd); });`;
    const fixture = `
      const { Worker } = require("node:worker_threads");
      const fs = require("node:fs");
      const path = require("node:path");
      const target = path.join(process.cwd(), "probe.txt");
      fs.writeFileSync(target, "x");
      const ino = fs.statSync(target).ino;
      const points = fd => {
        try { return fs.fstatSync(fd).ino === ino; } catch { return false; }
      };
      const w = new Worker(${JSON.stringify(worker)}, {
        eval: true,
        workerData: { target, openHow: ${JSON.stringify(openHow)} },
        ...${opts},
      });
      w.on("error", e => { console.error(e); process.exit(1); });
      w.on("message", m => {
        const during = points(m.fd);
        w.on("exit", () => console.log(JSON.stringify({ during, after: points(m.fd) })));
        w.postMessage("ack");
      });
    `;
    return run(fixture, "worker-track-unmanaged-fds");
  }

  test("fs.openSync fd is auto-closed at worker exit by default", async () => {
    expect(await probe("sync", "{}")).toEqual({
      stderr: "",
      // during=true proves the fd was live (confound guard); after=false proves the sweep closed it.
      out: { during: true, after: false },
      exitCode: 0,
    });
  });

  test("fs.openSync fd is auto-closed when trackUnmanagedFds: true", async () => {
    expect(await probe("sync", "{ trackUnmanagedFds: true }")).toEqual({
      stderr: "",
      out: { during: true, after: false },
      exitCode: 0,
    });
  });

  test("fs.openSync fd survives worker exit when trackUnmanagedFds: false", async () => {
    expect(await probe("sync", "{ trackUnmanagedFds: false }")).toEqual({
      stderr: "",
      out: { during: true, after: true },
      exitCode: 0,
    });
  });

  test("fs.open (callback) fd is auto-closed at worker exit", async () => {
    expect(await probe("async", "{}")).toEqual({
      stderr: "",
      out: { during: true, after: false },
      exitCode: 0,
    });
  });

  test("fs.promises.open FileHandle fd is closed at worker exit", async () => {
    // The worker keeps a strong reference, so only worker teardown (not
    // FileHandle GC) can close it. Node closes it in ~FileHandle.
    expect(await probe("promise", "{}")).toEqual({
      stderr: "",
      out: { during: true, after: false },
      exitCode: 0,
    });
  });

  test("fs.promises.open FileHandle fd is closed even with trackUnmanagedFds: false", async () => {
    // The opt-out covers raw fds only; Node closes a FileHandle at worker exit regardless.
    expect(await probe("promise", "{ trackUnmanagedFds: false }")).toEqual({
      stderr: "",
      out: { during: true, after: false },
      exitCode: 0,
    });
  });

  test("closing a tracked fd untracks it, so a later untracked reuse of the number survives", async () => {
    // With trackUnmanagedFds: false only FileHandle fds are tracked. Open one
    // (tracked), close it (must untrack), then fs.openSync another file: the
    // kernel reuses the same number, untracked. If the close had not untracked
    // it, the exit sweep would close the reused fd out from under the parent.
    const worker =
      `const { parentPort, workerData } = require("node:worker_threads");` +
      `const fs = require("node:fs");` +
      `fs.promises.open(workerData.target, "r").then(async h => {` +
      `  const first = h.fd;` +
      `  await h.close();` +
      `  const fd = fs.openSync(workerData.other, "r");` +
      `  parentPort.on("message", () => process.exit(0));` +
      `  parentPort.postMessage({ reused: fd === first, fd });` +
      `});`;
    const fixture = `
      const { Worker } = require("node:worker_threads");
      const fs = require("node:fs");
      const path = require("node:path");
      const target = path.join(process.cwd(), "probe.txt");
      const other = path.join(process.cwd(), "other.txt");
      fs.writeFileSync(target, "x");
      fs.writeFileSync(other, "y");
      const ino = fs.statSync(other).ino;
      const points = fd => {
        try { return fs.fstatSync(fd).ino === ino; } catch { return false; }
      };
      const w = new Worker(${JSON.stringify(worker)}, {
        eval: true, workerData: { target, other }, trackUnmanagedFds: false,
      });
      w.on("error", e => { console.error(e); process.exit(1); });
      w.on("message", m => {
        const during = points(m.fd);
        w.on("exit", () => console.log(JSON.stringify({ reused: m.reused, during, after: points(m.fd) })));
        w.postMessage("ack");
      });
    `;
    expect(await run(fixture, "worker-track-unmanaged-fds-untrack")).toEqual({
      stderr: "",
      out: { reused: true, during: true, after: true },
      exitCode: 0,
    });
  });

  test("a FileHandle transferred to a nested worker is owned by the receiver", async () => {
    // The sender gives the fd up on transfer; the receiver owns it and its
    // teardown closes it. Neither side leaks it and the receiver can use it.
    const inner =
      `const { parentPort, workerData } = require("node:worker_threads");` +
      `const fs = require("node:fs");` +
      `const fd = workerData.handle.fd;` +
      `let ok; try { ok = fs.fstatSync(fd).ino === workerData.ino; } catch { ok = false; }` +
      `parentPort.postMessage({ ok });` +
      `setInterval(() => {}, 1e9);`;
    const outer =
      `const { Worker, parentPort, workerData } = require("node:worker_threads");` +
      `require("node:fs").promises.open(workerData.target, "r").then(handle => {` +
      `  const w = new Worker(${JSON.stringify(inner)}, {` +
      `    eval: true, workerData: { handle, ino: workerData.ino }, transferList: [handle],` +
      `  });` +
      `  w.on("message", m => parentPort.postMessage(m));` +
      `});`;
    const fixture = `
        const { Worker } = require("node:worker_threads");
        const fs = require("node:fs");
        const path = require("node:path");
        ${openFdsSrc}
        const target = path.join(process.cwd(), "probe.txt");
        fs.writeFileSync(target, "x");
        const ino = fs.statSync(target).ino;
        const w = new Worker(${JSON.stringify(outer)}, { eval: true, workerData: { target, ino } });
        w.on("error", e => { console.error(e); process.exit(1); });
        w.on("message", async m => {
          const during = openFds(ino);
          await w.terminate();
          console.log(JSON.stringify({ ok: m.ok, during, after: openFds(ino) }));
        });
      `;
    expect(await run(fixture, "worker-track-unmanaged-fds-transfer")).toEqual({
      stderr: "",
      out: { ok: true, during: 1, after: 0 },
      exitCode: 0,
    });
  }, 15_000); // Two worker startups in series; a debug build needs more than the default.

  test("fs.createReadStream fds mid-read are closed when the worker is terminated", async () => {
    // No raw fd in user code: ReadStream opens through the same native fs.open
    // path, so a stream that is still reading when terminate() lands must not
    // leave its fd behind.
    const worker =
      `const fs = require("node:fs");` +
      `const { parentPort, workerData } = require("node:worker_threads");` +
      `for (let i = 0; i < 10; i++) {` +
      `  const r = fs.createReadStream(workerData, { highWaterMark: 1024 });` +
      `  r.on("data", () => {});` +
      `}` +
      `parentPort.on("message", () => parentPort.postMessage("reading"));` +
      `parentPort.postMessage("ready");` +
      `setInterval(() => {}, 1e9);`;
    const fixture = `
      const { Worker } = require("node:worker_threads");
      const fs = require("node:fs");
      const path = require("node:path");
      ${openFdsSrc}
      const target = path.join(process.cwd(), "big.bin");
      fs.writeFileSync(target, new Uint8Array(1 << 20));
      const ino = fs.statSync(target).ino;
      (async () => {
        const w = new Worker(${JSON.stringify(worker)}, { eval: true, workerData: target });
        await new Promise((res, rej) => { w.once("message", res); w.once("error", rej); });
        // Round-trip once more so the streams have had a tick to open.
        w.postMessage("go");
        await new Promise((res, rej) => { w.once("message", res); w.once("error", rej); });
        const during = openFds(ino);
        await w.terminate();
        console.log(JSON.stringify({ during, after: openFds(ino) }));
      })();
    `;
    const { stderr, out, exitCode } = await run(fixture, "worker-track-unmanaged-fds-stream");
    // during > 0 proves the streams really had fds open while the worker ran.
    expect({ stderr, duringPositive: out?.during > 0, after: out?.after, exitCode }).toEqual({
      stderr: "",
      duringPositive: true,
      after: 0,
      exitCode: 0,
    });
  });
});
