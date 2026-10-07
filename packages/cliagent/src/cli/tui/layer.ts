import { run as runTui, type TuiInput } from "@cliagent/tui"
import { Global } from "@cliagent/core/global"
import { AppNodeBuilder } from "@cliagent/core/effect/app-node-builder"
import { Effect } from "effect"

export function run(input: TuiInput) {
  return runTui(input).pipe(Effect.provide(AppNodeBuilder.build(Global.node)))
}
