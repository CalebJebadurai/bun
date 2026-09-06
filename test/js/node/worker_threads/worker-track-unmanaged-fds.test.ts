import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, isWindows, tempDir } from "harness";

// trackUnmanagedFds: fs.open/openSync fds left open in a worker must be closed when the
// worker exits (default / true), and must be left alone when the user opts out (false).
// Verified by inode identity so fd-number reuse can never fake a verdict. Windows is
// skipped because workers receive uv-tagged fd numbers that don't map 1:1 to parent fds.
describe.concurrent.skipIf(isWindows)("Worker trackUnmanagedFds", () => {
  async function probe(openHow: "sync" | "async" | "promise", closeIt: boolean, opts: string) {
    // The worker waits for a parent ack before exiting so `during` is always
    // captured while the fd is still live (no race with the exit sweep).
    const worker =
      `const { parentPort, workerData } = require("node:worker_threads");` +
      `const fs = require("node:fs");` +
      `const done = fd => {` +
      `  if (workerData.closeIt) fs.closeSync(fd);` +
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
        workerData: { target, openHow: ${JSON.stringify(openHow)}, closeIt: ${closeIt} },
        ...${opts},
      });
      w.on("error", e => { console.error(e); process.exit(1); });
      w.on("message", m => {
        const during = ${closeIt} || points(m.fd);
        w.on("exit", () => console.log(JSON.stringify({ during, after: points(m.fd) })));
        w.postMessage("ack");
      });
    `;
    using dir = tempDir("worker-track-unmanaged-fds", {});
    await using proc = Bun.spawn({
      cmd: [bunExe(), "-e", fixture],
      env: bunEnv,
      cwd: String(dir),
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    return { stderr, out: JSON.parse(stdout || "null"), exitCode };
  }

  test("fs.openSync fd is auto-closed at worker exit by default", async () => {
    expect(await probe("sync", false, "{}")).toEqual({
      stderr: "",
      // during=true proves the fd was live (confound guard); after=false proves the sweep closed it.
      out: { during: true, after: false },
      exitCode: 0,
    });
  });

  test("fs.openSync fd is auto-closed when trackUnmanagedFds: true", async () => {
    expect(await probe("sync", false, "{ trackUnmanagedFds: true }")).toEqual({
      stderr: "",
      out: { during: true, after: false },
      exitCode: 0,
    });
  });

  test("fs.openSync fd survives worker exit when trackUnmanagedFds: false", async () => {
    expect(await probe("sync", false, "{ trackUnmanagedFds: false }")).toEqual({
      stderr: "",
      out: { during: true, after: true },
      exitCode: 0,
    });
  });

  test("fs.open (callback) fd is auto-closed at worker exit", async () => {
    expect(await probe("async", false, "{}")).toEqual({
      stderr: "",
      out: { during: true, after: false },
      exitCode: 0,
    });
  });

  test("fs.promises.open FileHandle fd is excluded from the sweep", async () => {
    // Node only tracks raw fs.open/openSync fds; a FileHandle is managed and
    // may be transferred to another thread, so the sweep must never close its
    // fd out from under a receiver. The worker keeps a strong reference so
    // only the sweep (not FileHandle GC) could close it here.
    expect(await probe("promise", false, "{}")).toEqual({
      stderr: "",
      out: { during: true, after: true },
      exitCode: 0,
    });
  });

  test("fs.closeSync drops the fd from tracking (no double-close)", async () => {
    expect(await probe("sync", true, "{}")).toEqual({
      stderr: "",
      out: { during: true, after: false },
      exitCode: 0,
    });
  });

  test("fs.createReadStream fds mid-read are closed when the worker is terminated", async () => {
    // No raw fd in user code: ReadStream opens through the same native fs.open
    // path, so a stream that is still reading when terminate() lands must not
    // leave its fd behind. Counted by inode over /proc/self/fd so nothing but
    // this file is measured.
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
      const target = path.join(process.cwd(), "big.bin");
      fs.writeFileSync(target, new Uint8Array(1 << 20));
      const ino = fs.statSync(target).ino;
      const openFds = () => {
        let n = 0;
        for (const f of fs.readdirSync("/proc/self/fd")) {
          try { if (fs.fstatSync(Number(f)).ino === ino) n++; } catch {}
        }
        return n;
      };
      (async () => {
        const w = new Worker(${JSON.stringify(worker)}, { eval: true, workerData: target });
        await new Promise((res, rej) => { w.once("message", res); w.once("error", rej); });
        // Round-trip once more so the streams have had a tick to open.
        w.postMessage("go");
        await new Promise((res, rej) => { w.once("message", res); w.once("error", rej); });
        const during = openFds();
        await w.terminate();
        console.log(JSON.stringify({ during, after: openFds() }));
      })();
    `;
    using dir = tempDir("worker-track-unmanaged-fds-stream", {});
    await using proc = Bun.spawn({
      cmd: [bunExe(), "-e", fixture],
      env: bunEnv,
      cwd: String(dir),
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    const out = JSON.parse(stdout || "null");
    // during > 0 proves the streams really had fds open while the worker ran.
    expect({ stderr, duringPositive: out?.during > 0, after: out?.after, exitCode }).toEqual({
      stderr: "",
      duringPositive: true,
      after: 0,
      exitCode: 0,
    });
  });
});
