import { execFile, spawn } from "child_process";
import { mkdtemp, realpath, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { delimiter, dirname, join } from "path";
import { promisify } from "util";

/**
 * Runs a code card's code, with nothing to reach.
 *
 * Under bubblewrap: no network, a read-only system, an empty tmpfs and no
 * home, with a clean environment. That last one is not hygiene: this process
 * holds the Anthropic API key (Omvida's bin/omvida-deck hands it over), and the
 * prototype's runner passed its whole environment on to the code it ran. So
 * bubblewrap itself starts without it: its --clearenv cleans what it execs, not
 * its own process, which is PID 1 in there with /proc mounted. The code is the
 * developer's own typing, or a card Claude wrote, so this guards against a
 * mistake rather than an attacker, but `system("rm -rf ~")` should cost nothing
 * either way. The limits are for the same mistakes: a recursive fork, a file
 * written in a loop. They are per process and per file, not a quota on the
 * whole of /dev, which the timeout bounds well enough for a mistake.
 *
 * A timeout kills the whole tree: bubblewrap's PID namespace dies with it. The
 * run's verdict comes back on a pipe of its own (fd 3), so nothing the code
 * prints can be mistaken for it, nor the other way round.
 *
 * One process per run, about 60 ms: fast enough to run at every pause in the
 * typing, and cheap enough not to keep an interpreter around that one run could
 * leave in a bad state.
 */

const TIMEOUT_MS = 5000;
/** What is kept of each stream. More than this is a loop, not an answer. */
const MAX_OUTPUT_BYTES = 64 * 1024;
/** Every shown value is cut in the harness, so only a very odd card gets here. */
const MAX_VERDICT_BYTES = 1024 * 1024;
const TMPFS_BYTES = 16 * 1024 * 1024;
const MEMORY_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PROCESSES = 64;

export interface SandboxReport {
  error: string | null;
  cases: Array<{ pass: boolean; actual: string | null; goal: string | null; error: string | null }>;
}

export interface SandboxResult {
  status: "ran" | "timeout" | "unavailable";
  report: SandboxReport | null;
  stdout: string;
  stderr: string;
  /** Why there is no report, when there is none. */
  failure: string | null;
  durationMs: number;
}

/**
 * Evaluates the source, then each case's expression and goal, comparing values.
 * All in the methods of a nameless module: a local of this file would be visible
 * through TOPLEVEL_BINDING to the code it runs, and a named module could collide
 * with a card's own `class Exercise`, or be reopened by it and pass a wrong answer.
 * Backtraces are cut to the frames in that code: the runner's own are noise to
 * someone reading their mistake. ARGV is emptied, or `gets` in a card would read
 * the input file, solutions and all.
 */
const RUBY_HARNESS = String.raw`
require "json"

Module.new do
  def self.describe(e)
    frames = e.backtrace.to_a.select { |line| line.match?(/\A(main\.rb|case \d+|goal \d+)/) }
    ([e.detailed_message(highlight: false)] + frames.map { |line| "\tfrom #{line}" }).join("\n").scrub
  end

  def self.attempt(code, file)
    [eval(code, TOPLEVEL_BINDING, file, 1), nil]
  rescue Exception => e
    [nil, describe(e)]
  end

  def self.shown(value)
    text = value.inspect.scrub
    text.length > 16_384 ? "#{text[0, 16_384]}... (cut off)" : text
  rescue Exception => e
    "(could not inspect: #{e.class})"
  end

  def self.judge(item, index)
    actual, error = attempt(item["expr"], "case #{index + 1}")
    return { pass: false, actual: nil, goal: nil, error: error } if error
    goal, error = attempt(item["goal"], "goal #{index + 1}")
    return { pass: false, actual: shown(actual), goal: nil, error: error } if error
    { pass: actual == goal, actual: shown(actual), goal: shown(goal), error: nil }
  rescue Exception => e
    { pass: false, actual: nil, goal: nil, error: describe(e) }
  end

  def self.run(input)
    _, error = attempt(input["source"], "main.rb")
    return { error: error, cases: [] } if error
    { error: nil, cases: input["cases"].each_with_index.map { |item, i| judge(item, i) } }
  end

  def self.main
    $stdout.sync = true
    report = run(JSON.parse(File.read(ARGV.shift)))
    verdict = IO.new(3, "w")
    verdict.write(JSON.generate(report))
    verdict.close
  end
end.main
`;

let rubyPath: Promise<string | null> | null = null;

/** The newest Ruby this machine has: mise's when it has one, else the system's. */
function findRuby(): Promise<string | null> {
  rubyPath ??= locateRuby();
  return rubyPath;
}

async function locateRuby(): Promise<string | null> {
  const given = process.env.FLASHCARD_RUBY;
  if (given != null && given !== "") return realpath(given).catch(() => null);
  try {
    const { stdout } = await promisify(execFile)("mise", ["which", "ruby"], { timeout: 5000 });
    const found = stdout.trim();
    if (found !== "") return await realpath(found);
  } catch {
    // No mise, or it pins no Ruby: the PATH's, below.
  }
  // Not through mise's shims: a shim needs mise and its config, which the
  // sandbox hides, and it failing here is what sent us to the PATH.
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "" || dir.includes("mise/shims")) continue;
    try {
      return await realpath(join(dir, "ruby"));
    } catch {
      continue;
    }
  }
  return null;
}

/** A Ruby outside /usr brings its install directory with it, read-only. */
function rubyBinds(ruby: string): string[] {
  if (ruby.startsWith("/usr/")) return [];
  const prefix = dirname(dirname(ruby));
  return ["--ro-bind", prefix, prefix];
}

function bubblewrapArgv(ruby: string, workDir: string): string[] {
  return [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--setenv", "PATH", "/usr/bin",
    "--setenv", "LANG", "C.UTF-8",
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--symlink", "usr/bin", "/bin",
    "--ro-bind-try", "/etc/ssl", "/etc/ssl",
    "--proc", "/proc",
    "--dev", "/dev",
    "--size", String(TMPFS_BYTES), "--tmpfs", "/tmp",
    "--ro-bind", workDir, "/exercise",
    "--chdir", "/tmp",
    ...rubyBinds(ruby),
    "/usr/bin/prlimit", `--as=${MEMORY_BYTES}`, `--nproc=${MAX_PROCESSES}`, `--fsize=${TMPFS_BYTES}`, "--core=0",
    ruby, "/exercise/harness.rb", "/exercise/input.json",
  ];
}

/** Stops collecting at the cap, and says it stopped. */
class CappedOutput {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly cap: number = MAX_OUTPUT_BYTES) {}
  add(chunk: Buffer): void {
    if (this.size < this.cap) this.chunks.push(chunk);
    this.size += chunk.length;
  }
  get full(): boolean {
    return this.size >= this.cap;
  }
  text(): string {
    const all = Buffer.concat(this.chunks).subarray(0, this.cap).toString("utf8");
    return this.full ? `${all}\n... (output cut off)` : all;
  }
}

const UNAVAILABLE = (failure: string, started: number): SandboxResult => ({
  status: "unavailable",
  report: null,
  stdout: "",
  stderr: "",
  failure,
  durationMs: Date.now() - started,
});

/** `signal` stops the run early: its result is a timeout, which nobody is waiting for. */
export async function runSandboxed(
  input: { source: string; cases: unknown[] },
  signal?: AbortSignal
): Promise<SandboxResult> {
  const started = Date.now();
  const ruby = await findRuby();
  if (ruby == null) return UNAVAILABLE("no ruby found: install one with mise", started);
  const workDir = await mkdtemp(join(tmpdir(), "flashcard-exercise-"));
  try {
    await writeFile(join(workDir, "harness.rb"), RUBY_HARNESS);
    await writeFile(join(workDir, "input.json"), JSON.stringify(input));
    return await spawnBubblewrap(bubblewrapArgv(ruby, workDir), started, signal);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function spawnBubblewrap(argv: string[], started: number, signal?: AbortSignal): Promise<SandboxResult> {
  return new Promise((resolve) => {
    // PATH alone, to find bwrap: see the top of this file.
    const child = spawn("bwrap", argv, { stdio: ["ignore", "pipe", "pipe", "pipe"], env: { PATH: process.env.PATH } });
    const stdout = new CappedOutput();
    const stderr = new CappedOutput();
    const verdict = new CappedOutput(MAX_VERDICT_BYTES);
    let timedOut = false;
    let cancelled = false;
    const kill = (): void => {
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, TIMEOUT_MS);
    const cancel = (): void => {
      cancelled = true;
      kill();
    };
    signal?.addEventListener("abort", cancel, { once: true });
    const collect = (into: CappedOutput) => (chunk: Buffer): void => {
      into.add(chunk);
      // A program printing forever is stopped now, not at the timeout.
      if (into.full) kill();
    };
    child.stdout!.on("data", collect(stdout));
    child.stderr!.on("data", collect(stderr));
    (child.stdio[3] as NodeJS.ReadableStream).on("data", collect(verdict));
    const finished = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    };
    child.on("error", (e) => {
      finished();
      resolve(UNAVAILABLE(`could not start the sandbox (${e.message}): is bubblewrap installed?`, started));
    });
    child.on("close", (code) => {
      finished();
      const durationMs = Date.now() - started;
      if (timedOut || cancelled) {
        resolve({
          status: "timeout",
          report: null,
          stdout: stdout.text(),
          stderr: stderr.text(),
          failure: cancelled ? "stopped: a newer run took its place" : `stopped after ${TIMEOUT_MS / 1000} seconds: an endless loop?`,
          durationMs,
        });
        return;
      }
      let report: SandboxReport | null = null;
      try {
        report = JSON.parse(verdict.text()) as SandboxReport;
      } catch {
        // It ended before reporting: `exit!`, a crash, the output cap.
      }
      // Bubblewrap couldn't set up, so the code never ran (no user namespaces,
      // say). That is the machine's fault, not an error in the answer.
      if (report == null && stderr.text().startsWith("bwrap: ")) {
        resolve(UNAVAILABLE(`could not start the sandbox (${stderr.text().trim()})`, started));
        return;
      }
      resolve({
        status: "ran",
        report,
        stdout: stdout.text(),
        stderr: stderr.text(),
        failure: report == null ? `the code ended before finishing (exit ${code ?? "killed"})` : null,
        durationMs,
      });
    });
  });
}
