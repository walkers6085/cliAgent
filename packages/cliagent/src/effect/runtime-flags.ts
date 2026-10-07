import { Config, ConfigProvider, Context, Effect, Layer, Option } from "effect"
import { ConfigService } from "@/effect/config-service"

const bool = (name: string) => Config.boolean(name).pipe(Config.withDefault(false))
const positiveInteger = (name: string) =>
  Config.number(name).pipe(
    Config.map((value) => (Number.isInteger(value) && value > 0 ? value : undefined)),
    Config.orElse(() => Config.succeed(undefined)),
  )
const experimental = bool("CLIAGENT_EXPERIMENTAL")
const enabledByExperimental = (name: string) =>
  Config.all({ experimental, enabled: Config.boolean(name).pipe(Config.option) }).pipe(
    Config.map((flags) => Option.getOrElse(flags.enabled, () => flags.experimental)),
  )

export class Service extends ConfigService.Service<Service>()("@cliagent/RuntimeFlags", {
  pure: bool("CLIAGENT_PURE"),
  disableExternalSkills: bool("CLIAGENT_DISABLE_EXTERNAL_SKILLS"),
  disableLspDownload: bool("CLIAGENT_DISABLE_LSP_DOWNLOAD"),
  disableClaudeCodePrompt: Config.all({
    broad: bool("CLIAGENT_DISABLE_CLAUDE_CODE"),
    direct: bool("CLIAGENT_DISABLE_CLAUDE_CODE_PROMPT"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  disableClaudeCodeSkills: Config.all({
    broad: bool("CLIAGENT_DISABLE_CLAUDE_CODE"),
    direct: bool("CLIAGENT_DISABLE_CLAUDE_CODE_SKILLS"),
  }).pipe(Config.map((flags) => flags.broad || flags.direct)),
  enableExa: Config.all({
    experimental,
    enabled: bool("CLIAGENT_ENABLE_EXA"),
    legacy: bool("CLIAGENT_EXPERIMENTAL_EXA"),
  }).pipe(Config.map((flags) => flags.experimental || flags.enabled || flags.legacy)),
  enableParallel: Config.all({
    enabled: bool("CLIAGENT_ENABLE_PARALLEL"),
    legacy: bool("CLIAGENT_EXPERIMENTAL_PARALLEL"),
  }).pipe(Config.map((flags) => flags.enabled || flags.legacy)),
  enableExperimentalModels: bool("CLIAGENT_ENABLE_EXPERIMENTAL_MODELS"),
  enableQuestionTool: bool("CLIAGENT_ENABLE_QUESTION_TOOL"),
  experimentalReferences: enabledByExperimental("CLIAGENT_EXPERIMENTAL_REFERENCES"),
  experimentalBackgroundSubagents: enabledByExperimental("CLIAGENT_EXPERIMENTAL_BACKGROUND_SUBAGENTS"),
  experimentalLspTy: bool("CLIAGENT_EXPERIMENTAL_LSP_TY"),
  experimentalLspTool: enabledByExperimental("CLIAGENT_EXPERIMENTAL_LSP_TOOL"),
  experimentalOxfmt: enabledByExperimental("CLIAGENT_EXPERIMENTAL_OXFMT"),
  experimentalPlanMode: enabledByExperimental("CLIAGENT_EXPERIMENTAL_PLAN_MODE"),
  experimentalCodeMode: enabledByExperimental("CLIAGENT_EXPERIMENTAL_CODE_MODE"),
  experimentalEventSystem: enabledByExperimental("CLIAGENT_EXPERIMENTAL_EVENT_SYSTEM"),
  experimentalWorkspaces: enabledByExperimental("CLIAGENT_EXPERIMENTAL_WORKSPACES"),
  experimentalIconDiscovery: enabledByExperimental("CLIAGENT_EXPERIMENTAL_ICON_DISCOVERY"),
  outputTokenMax: positiveInteger("CLIAGENT_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  bashDefaultTimeoutMs: positiveInteger("CLIAGENT_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  client: Config.string("CLIAGENT_CLIENT").pipe(Config.withDefault("cli")),
}) {}

export type Info = Context.Service.Shape<typeof Service>

const emptyConfigLayer = Service.layer.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
)

export const layer = (overrides: Partial<Info> = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const flags = yield* Service
      return Service.of({ ...flags, ...overrides })
    }),
  ).pipe(Layer.provide(emptyConfigLayer))

export const node = LayerNode.make({ service: Service, layer: Service.layer.pipe(Layer.orDie), deps: [] })

export * as RuntimeFlags from "./runtime-flags"
import { LayerNode } from "@cliagent/core/effect/layer-node"
