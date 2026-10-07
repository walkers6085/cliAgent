// Subprocess test harness for the cliagent CLI. Spawns the real binary against
// a TestLLMServer running in-process at a random port, with full env isolation.
//
// This is the missing test tier: in-process tests can't catch bugs that span
// argv parsing → server boot → SDK call → event consumption → exit code (like
// the original /event race or #27371's invalid-model hang).
//
// Configuration flows through cliagent's built-in test affordances:
//   - CLIAGENT_CONFIG_CONTENT      : provider config inline, no files to find
//   - CLIAGENT_TEST_HOME           : pins os.homedir() → tmpdir
//   - CLIAGENT_DISABLE_PROJECT_CONFIG : skip walking up for cliagent.json
//   - CLIAGENT_PURE                : skip external plugin discovery + install
//   - CLIAGENT_DISABLE_AUTOUPDATE / AUTOCOMPACT / MODELS_FETCH : no background work
// Plus HOME / XDG_* pointing at the tmpdir for belt-and-suspenders isolation.
//
// Today only `cliagent.run` is fully wired. The shape supports adding more
// builders (`cliagent.serve(opts)`, `cliagent.acp(opts)`, `cliagent.auth(...)`)
// without changing the fixture. Long-lived commands like `serve` will need a
// different return shape — see the TODO at the bottom of CliAgentCli.
import { test, type TestOptions } from "bun:test"
import { FSUtil } from "@cliagent/core/fs-util"
import { AppNodeBuilder } from "@cliagent/core/effect/app-node-builder"
import { LayerNode } from "@cliagent/core/effect/layer-node"
import { AppProcess } from "@cliagent/core/process"
import { Deferred, Duration, Effect, Layer, Queue, Schedule, Scope, Stream } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { ChildProcess } from "effect/unstable/process"
import path from "node:path"
import { TestLLMServer } from "./llm-server"
import { testProviderConfig } from "./test-provider"
import { it } from "./effect"

const cliagentRoot = path.resolve(import.meta.dir, "../../")
const cliEntry = path.join(cliagentRoot, "src/index.ts")

export const testModelID = "test/test-model"

// Wrap a Bun subprocess pipe (or any ReadableStream<Uint8Array>) as a Stream.
// Centralizes the `evaluate` + `onError` boilerplate and tags errors with the
// stream name so a stderr/stdout failure is greppable in logs.
function fromBunStream(name: string, get: () => ReadableStream<Uint8Array>) {
  return Stream.fromReadableStream({
    evaluate: get,
    onError: (cause) => new Error(`${name} stream error: ${String(cause)}`),
  })
}

// Long-lived processes (serve, acp) all want the same stderr drain: read every
// chunk, push to a tail buffer, swallow stream errors (the child closing the
// pipe is normal). `log: true` surfaces a real protocol error to logs so a
// regression doesn't silently disappear.
function forkStderrDrain(stream: ReadableStream<Uint8Array>, into: string[]) {
  return Effect.forkScoped(
    fromBunStream("stderr", () => stream).pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) => Effect.sync(() => into.push(chunk))),
      Effect.ignore({ log: true }),
    ),
  )
}

function isolatedEnv(home: string, configJson: string): Record<string, string> {
  return {
    CLIAGENT_TEST_HOME: home,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    CLIAGENT_CONFIG_CONTENT: configJson,
    CLIAGENT_DISABLE_PROJECT_CONFIG: "1",
    CLIAGENT_PURE: "1",
    CLIAGENT_DISABLE_AUTOUPDATE: "1",
    CLIAGENT_DISABLE_AUTOCOMPACT: "1",
    CLIAGENT_DISABLE_MODELS_FETCH: "1",
    CLIAGENT_AUTH_CONTENT: "{}",
  }
}

export type RunResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
}

export type RunHandle = {
  readonly interrupt: () => void
  readonly result: Effect.Effect<RunResult>
}

export type SpawnOpts = { readonly timeoutMs?: number; readonly env?: Record<string, string> }

// Typed equivalent of constructing argv for `cliagent run`. New flags should
// land here so tests stay grep-able and refactor-safe.
export type RunOpts = SpawnOpts & {
  readonly model?: string
  readonly agent?: string
  readonly format?: "default" | "json"
  readonly command?: string
  readonly printLogs?: boolean
  readonly permission?: Record<string, "ask" | "allow" | "deny">
  readonly extraArgs?: string[]
}

export type CliAgentCli = {
  // High-level: run a single prompt against the test model. Short-lived.
  readonly run: (message: string, opts?: RunOpts) => Effect.Effect<RunResult>
  readonly startRun: (message: string, opts?: RunOpts) => Effect.Effect<RunHandle, never, Scope.Scope>
  // Escape hatch: any CLI invocation with full control over argv. Used to test
  // commands that don't yet have a typed builder.
  readonly spawn: (args: string[], opts?: SpawnOpts) => Effect.Effect<RunResult>
  // Convenience assertion. Dumps captured stderr/stdout on mismatch so CI
  // failures are debuggable without re-running locally.
  readonly expectExit: (result: RunResult, expected: number, label?: string) => void
  // Parse `--format json` stdout into one event object per non-empty line.
  // The CLI writes `JSON.stringify({ type, sessionID, ... }) + EOL` for each
  // event (see src/cli/cmd/run.ts `emit`). Throws on a malformed line so
  // tests fail loudly rather than silently skipping data.
  readonly parseJsonEvents: (stdout: string) => Array<Record<string, unknown>>
}

export type CliFixture = {
  readonly llm: TestLLMServer["Service"]
  readonly home: string
  readonly cliagent: CliAgentCli
}

// Provisions a TestLLMServer + tmpdir + spawn helper and invokes fn. Cleans
// up the tmpdir on scope exit. TestLLMServer.layer is provided internally so
// the caller doesn't need to wire it up — the fixture's lifetime is tied to
// the surrounding Scope.
export function withCliFixture<A, E>(
  fn: (input: CliFixture) => Effect.Effect<A, E, Scope.Scope | HttpClient.HttpClient>,
): Effect.Effect<A, E | unknown, Scope.Scope> {
  return Effect.gen(function* () {
    const llm = yield* TestLLMServer
    const fs = yield* FSUtil.Service
    const appProc = yield* AppProcess.Service

    const home = yield* fs.makeTempDirectory({ prefix: "oc-cli-" })
    yield* Effect.addFinalizer(() =>
      fs
        .remove(home, { recursive: true })
        .pipe(Effect.retry(Schedule.spaced("50 millis").pipe(Schedule.both(Schedule.recurs(20)))), Effect.ignore),
    )

    const configJson = JSON.stringify(testProviderConfig(llm.url))
    const env = isolatedEnv(home, configJson)

    const spawn = Effect.fn("cliagent.spawn")(function* (args: string[], opts?: SpawnOpts) {
      const start = Date.now()
      const timeoutMs = opts?.timeoutMs ?? 30_000
      // stdin: "ignore" so the child doesn't see a piped stdin and block
      // on `Bun.stdin.text()` (see src/cli/cmd/run.ts — non-TTY stdin is
      // consumed as the prompt). The old Process.run wrapper defaulted to
      // ignore; ChildProcess.make defaults to pipe, so we set it explicitly.
      const command = ChildProcess.make("bun", ["run", cliEntry, ...args], {
        cwd: home,
        env: { ...env, ...opts?.env },
        extendEnv: true,
        stdin: "ignore",
      })
      // Pass timeout to appProc.run rather than wrapping with
      // Effect.timeoutOrElse externally: AppProcess.run is itself scoped, so
      // its built-in timeout triggers the acquireRelease kill finalizer
      // inside cross-spawn-spawner *before* surfacing the AppProcessError —
      // guaranteeing the child is dead by the time the test continues.
      // External timeoutOrElse interrupts the run fiber but races the
      // scope close, which can leak the child past the test boundary.
      //
      // Catch AppProcessError (timeout OR spawn failure) and synthesize a
      // non-zero result so the test sees it via the usual `expectExit`
      // path rather than as an unhandled Effect failure.
      const result = yield* appProc.run(command, { timeout: Duration.millis(timeoutMs) }).pipe(
        Effect.catchTag("AppProcessError", (err) =>
          Effect.succeed({
            command: err.command,
            exitCode: err.exitCode ?? -1,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from((err.stderr ?? String(err.cause ?? err.message)) + "\n"),
            stdoutTruncated: false,
            stderrTruncated: false,
          } satisfies AppProcess.RunResult),
        ),
      )
      return {
        exitCode: result.exitCode,
        stdout: normalizeLines(result.stdout.toString()),
        stderr: normalizeLines(result.stderr.toString()),
        durationMs: Date.now() - start,
      }
    })

    const runArgs = (message: string, opts?: RunOpts) => {
      const argv: string[] = ["run"]
      if (opts?.printLogs) argv.push("--print-logs")
      argv.push("--model", opts?.model ?? testModelID)
      if (opts?.agent) argv.push("--agent", opts.agent)
      if (opts?.format) argv.push("--format", opts.format)
      if (opts?.command) argv.push("--command", opts.command)
      if (opts?.extraArgs) argv.push(...opts.extraArgs)
      argv.push(message)
      return argv
    }

    const runOpts = (opts?: RunOpts): SpawnOpts | undefined => {
      if (!opts?.permission) return opts
      return {
        ...opts,
        env: {
          ...opts.env,
          CLIAGENT_CONFIG_CONTENT: JSON.stringify({
            ...testProviderConfig(llm.url),
            permission: opts.permission,
          }),
        },
      }
    }

    const run = (message: string, opts?: RunOpts): Effect.Effect<RunResult> => {
      return spawn(runArgs(message, opts), runOpts(opts))
    }

    const startRun = Effect.fn("cliagent.startRun")(function* (message: string, opts?: RunOpts) {
      const start = Date.now()
      const options = runOpts(opts)
      const proc = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.spawn(["bun", "run", cliEntry, ...runArgs(message, opts)], {
            cwd: home,
            env: { ...process.env, ...env, ...options?.env },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          }),
        ),
        (child) =>
          Effect.promise(() => {
            child.kill()
            return child.exited
          }).pipe(Effect.ignore),
      )
      const stdout = new Response(proc.stdout).text()
      const stderr = new Response(proc.stderr).text()

      return {
        interrupt: () => proc.kill("SIGINT"),
        result: Effect.promise(async () => ({
          exitCode: await proc.exited,
          stdout: normalizeLines(await stdout),
          stderr: normalizeLines(await stderr),
          durationMs: Date.now() - start,
        })),
      } satisfies RunHandle
    })

    const cliagent: CliAgentCli = { run, startRun, spawn, expectExit, parseJsonEvents }

    return yield* fn({ llm, home, cliagent })
    // FetchHttpClient is provided so test bodies can `yield* HttpClient.HttpClient`
    // and hit endpoints on `cliagent.serve()` without rolling their own fetch.
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        TestLLMServer.layer,
        FetchHttpClient.layer,
        AppNodeBuilder.build(LayerNode.group([FSUtil.node, AppProcess.node])),
      ),
    ),
  )
}

function parseJsonEvents(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function normalizeLines(value: string) {
  return value.replaceAll("\r\n", "\n")
}

// Convenience for the common assertion pattern. Dumps stderr/stdout when
// the exit code doesn't match — saves debugging time on CI failures.
function expectExit(result: RunResult, expected: number, label = "cliagent") {
  if (result.exitCode === expected) return
  const tail = (s: string, n: number) => (s.length > n ? "..." + s.slice(-n) : s)
  // eslint-disable-next-line no-console
  console.error(`[${label}] expected exit ${expected}, got ${result.exitCode} after ${result.durationMs}ms`)
  // eslint-disable-next-line no-console
  console.error(`[${label}] stderr (last 2000):\n${tail(result.stderr, 2000)}`)
  // eslint-disable-next-line no-console
  console.error(`[${label}] stdout (last 500):\n${tail(result.stdout, 500)}`)
  throw new Error(`${label}: expected exit ${expected}, got ${result.exitCode}`)
}

// `cliIt.live(name, fixture => effect)` is the same as
// `it.live(name, () => withCliFixture(fixture))` — one fewer nesting level at
// every call site. Use this for any test that needs the cliagent CLI fixture.
//
// Subprocess tests must run against the real clock — a TestClock-paused
// environment can't drive a child process. If you need `.only` or `.skip`, fall
// back to `it.live` + `withCliFixture` directly.
// Body's R is `Scope.Scope | never` so tests can yield* scope-requiring
// resources (e.g. `cliagent.serve`) without an extra `Effect.scoped` wrapper —
// `withCliFixture`'s outer scope is the natural lifetime.
export const cliIt = {
  live: <A, E>(
    name: string,
    body: (input: CliFixture) => Effect.Effect<A, E, Scope.Scope | HttpClient.HttpClient>,
    opts?: number | TestOptions,
  ) => it.live(name, () => withCliFixture(body), opts),
  concurrent: <A, E>(
    name: string,
    body: (input: CliFixture) => Effect.Effect<A, E, Scope.Scope | HttpClient.HttpClient>,
    opts?: number | TestOptions,
  ) =>
    (process.platform === "win32" ? test : test.concurrent)(
      name,
      () => Effect.runPromise(Effect.scoped(withCliFixture(body))),
      opts,
    ),
}
