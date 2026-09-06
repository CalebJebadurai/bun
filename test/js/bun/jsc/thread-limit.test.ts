import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { bunEnv, bunExe, isLinux } from "harness";

// On Linux, threads count toward RLIMIT_NPROC (the same counter a cgroup
// pids.max enforces). The kernel does not enforce the limit for root, so a
// root test runner drops to `nobody` through runuser.
const isRoot = process.getuid?.() === 0;
const hasPrlimit = isLinux && !!Bun.which("prlimit");
const hasRunuser = !!Bun.which("runuser");
const canLimitThreads = hasPrlimit && (!isRoot || hasRunuser);

/** Threads that already belong to `uid`. RLIMIT_NPROC is per uid, not per process. */
function threadsOwnedBy(uid: number): number {
  let total = 0;
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    let status: string;
    try {
      status = readFileSync(`/proc/${pid}/status`, "utf8");
    } catch {
      continue;
    }
    const owner = status.match(/^Uid:\s+(\d+)/m);
    if (!owner || Number(owner[1]) !== uid) continue;
    const threads = status.match(/^Threads:\s+(\d+)/m);
    total += threads ? Number(threads[1]) : 1;
  }
  return total;
}

function spawnWithThreadLimit(extraThreads: number, script: string) {
  const uid = isRoot ? 65534 : process.getuid!();
  const limit = threadsOwnedBy(uid) + extraThreads;
  const cmd = [Bun.which("prlimit")!, `--nproc=${limit}`, bunExe(), "-e", script];
  if (isRoot) cmd.unshift(Bun.which("runuser")!, "-u", "nobody", "--");
  return Bun.spawn({
    cmd,
    // `nobody` has no writable home.
    env: { ...bunEnv, HOME: "/tmp" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test.skipIf(!canLimitThreads)("a GC under a thread limit does not abort the process", async () => {
  // Room for the main thread only. The GC's parallel markers get no thread,
  // so a synchronous GC has to finish on the main thread. The heap has to be
  // big enough for the collector to ask for markers.
  await using proc = spawnWithThreadLimit(1, `
    let keep = [];
    for (let i = 0; i < 200; i++) {
      keep.push(new Array(10000).fill({ i }));
      if (i % 50 === 0) keep = [];
    }
    Bun.gc(true);
    console.log("ok");
  `);
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect(stdout).toBe("ok\n");
  expect(stderr).not.toContain("ASSERTION FAILED");
  expect(exitCode).toBe(0);
});

test.skipIf(!canLimitThreads)("new Worker throws ERR_WORKER_INIT_FAILED when the OS refuses the thread", async () => {
  await using proc = spawnWithThreadLimit(6, `
    const workers = [];
    let failure;
    for (let i = 0; i < 40 && !failure; i++) {
      try {
        workers.push(new Worker("data:text/javascript,postMessage(1)"));
      } catch (e) {
        failure = { code: e.code, message: e.message, name: e.name };
      }
    }
    console.log(JSON.stringify(failure));
    for (const w of workers) w.terminate();
  `);
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect(JSON.parse(stdout)).toEqual({
    code: "ERR_WORKER_INIT_FAILED",
    message: "Worker initialization failure: EAGAIN",
    name: "Error",
  });
  expect(stderr).not.toContain("ASSERTION FAILED");
  expect(exitCode).toBe(0);
});
