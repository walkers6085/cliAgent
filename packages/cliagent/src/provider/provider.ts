import { LayerNode } from "@cliagent/core/effect/layer-node"
import fuzzysort from "fuzzysort"
import { Config } from "@/config/config"
import type { ConfigV1 } from "@cliagent/core/v1/config/config"
import { mapValues, mergeDeep, omit, pickBy, sortBy } from "remeda"
import { NoSuchModelError } from "ai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { Hash } from "@cliagent/core/util/hash"
import { Plugin } from "../plugin"
import { serviceUse } from "@cliagent/core/effect/service-use"
import { type LanguageModelV3 } from "@ai-sdk/provider"
import { Auth } from "../auth"
import { Env } from "../env"
import { iife } from "@/util/iife"
import { Global } from "@cliagent/core/global"
import path from "path"
import { Effect, Layer, Context, Schema, Types } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { EffectPromise } from "@/effect/promise"
import { FSUtil } from "@cliagent/core/fs-util"
import { isRecord } from "@/util/record"
import { optional } from "@cliagent/core/schema"
import { ProviderTransform } from "./transform"
import { ProviderV2 } from "@cliagent/core/provider"
import { ModelV2 } from "@cliagent/core/model"
import { ModelStatus } from "./model-status"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderError } from "./error"

// There are no built-in providers: every provider comes from the `provider` section of the config
// and is driven by the OpenAI-compatible SDK (Mistral, z.ai, OpenRouter, Ollama, vLLM, DeepSeek, ...).
export const SDK_PACKAGE = "@ai-sdk/openai-compatible"

function wrapSSE(res: Response, ms: number, ctl: AbortController) {
  if (typeof ms !== "number" || ms <= 0) return res
  if (!res.body) return res
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return res

  const reader = res.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const part = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        const id = setTimeout(() => {
          const err = new ProviderError.ResponseStreamError("SSE read timed out")
          ctl.abort(err)
          reader.cancel(err).catch(() => {})
          reject(err)
        }, ms)

        reader.read().then(
          (part) => {
            clearTimeout(id)
            resolve(part)
          },
          (err) => {
            clearTimeout(id)
            reject(err)
          },
        )
      })

      if (part.done) {
        ctrl.close()
        return
      }

      ctrl.enqueue(part.value)
    },
    async cancel(reason) {
      ctl.abort(reason)
      await reader.cancel(reason)
    },
  })

  return new Response(body, {
    headers: new Headers(res.headers),
    status: res.status,
    statusText: res.statusText,
  })
}

function timeoutController(ms: number) {
  const ctl = new AbortController()
  const id = setTimeout(() => ctl.abort(new ProviderError.HeaderTimeoutError(ms)), ms)
  return {
    signal: ctl.signal,
    clear: () => clearTimeout(id),
  }
}

// Applies the `headerTimeout`, `chunkTimeout` (SSE idle) and `timeout` provider options at the
// fetch layer, on top of `options.fetch` when a custom fetch is configured.
function timeoutFetch(options: Record<string, any>) {
  const customFetch = options["fetch"]
  const chunkTimeout = options["chunkTimeout"] ?? 300_000
  const headerTimeout = options["headerTimeout"] ?? 300_000
  const timeout = options["timeout"]

  return async (input: any, init?: BunFetchRequestInit) => {
    const fetchFn = customFetch ?? fetch
    const opts = init ?? {}
    const chunkAbortCtl = typeof chunkTimeout === "number" && chunkTimeout > 0 ? new AbortController() : undefined
    const headerTimeoutMs = headerTimeout === false ? undefined : headerTimeout
    const headerTimeoutCtl = typeof headerTimeoutMs === "number" ? timeoutController(headerTimeoutMs) : undefined
    const signals: AbortSignal[] = []

    if (opts.signal) signals.push(opts.signal)
    if (chunkAbortCtl) signals.push(chunkAbortCtl.signal)
    if (headerTimeoutCtl) signals.push(headerTimeoutCtl.signal)
    if (timeout !== undefined && timeout !== null && timeout !== false) signals.push(AbortSignal.timeout(timeout))

    const combined = signals.length === 0 ? null : signals.length === 1 ? signals[0] : AbortSignal.any(signals)
    if (combined) opts.signal = combined

    const res = await fetchFn(input, {
      ...opts,
      // @ts-ignore see here: https://github.com/oven-sh/bun/issues/16682
      timeout: false,
    }).finally(() => headerTimeoutCtl?.clear())

    if (!chunkAbortCtl) return res
    return wrapSSE(res, chunkTimeout, chunkAbortCtl)
  }
}

const ProviderApiInfo = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  npm: Schema.String,
})

const ProviderModalities = Schema.Struct({
  text: Schema.Boolean,
  audio: Schema.Boolean,
  image: Schema.Boolean,
  video: Schema.Boolean,
  pdf: Schema.Boolean,
})

const ProviderInterleavedField = Schema.Union([
  Schema.Literals(["reasoning", "reasoning_content", "reasoning_text"]),
  Schema.String,
])

const ProviderInterleaved = Schema.Union([
  Schema.Boolean,
  Schema.Struct({
    field: ProviderInterleavedField,
  }),
])

const ProviderCapabilities = Schema.Struct({
  temperature: Schema.Boolean,
  reasoning: Schema.Boolean,
  attachment: Schema.Boolean,
  toolcall: Schema.Boolean,
  input: ProviderModalities,
  output: ProviderModalities,
  interleaved: ProviderInterleaved,
})

const ProviderCacheCost = Schema.Struct({
  read: Schema.Finite,
  write: Schema.Finite,
})

const ProviderCostTier = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache: ProviderCacheCost,
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Finite,
  }),
})

const ProviderCost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache: ProviderCacheCost,
  tiers: optional(Schema.Array(ProviderCostTier)),
  experimentalOver200K: optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache: ProviderCacheCost,
    }),
  ),
})

const ProviderLimit = Schema.Struct({
  context: Schema.Finite,
  input: optional(Schema.Finite),
  output: Schema.Finite,
})

export const Model = Schema.Struct({
  id: ModelV2.ID,
  providerID: ProviderV2.ID,
  api: ProviderApiInfo,
  name: Schema.String,
  family: optional(Schema.String),
  capabilities: ProviderCapabilities,
  cost: ProviderCost,
  limit: ProviderLimit,
  status: ModelStatus,
  options: Schema.Record(Schema.String, Schema.Any),
  headers: Schema.Record(Schema.String, Schema.String),
  release_date: Schema.String,
  variants: optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Any))),
}).annotate({ identifier: "Model" })
export type Model = Types.DeepMutable<Schema.Schema.Type<typeof Model>>

export const Info = Schema.Struct({
  id: ProviderV2.ID,
  name: Schema.String,
  source: Schema.Literals(["env", "config", "custom", "api"]),
  env: Schema.Array(Schema.String),
  key: optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Any),
  models: Schema.Record(Schema.String, Model),
}).annotate({ identifier: "Provider" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

const DefaultModelIDs = Schema.Record(Schema.String, Schema.String)

export const ListResult = Schema.Struct({
  all: Schema.Array(Info),
  default: DefaultModelIDs,
  connected: Schema.Array(Schema.String),
})
export type ListResult = Types.DeepMutable<Schema.Schema.Type<typeof ListResult>>

export const ConfigProvidersResult = Schema.Struct({
  providers: Schema.Array(Info),
  default: DefaultModelIDs,
})
export type ConfigProvidersResult = Types.DeepMutable<Schema.Schema.Type<typeof ConfigProvidersResult>>

export function toPublicInfo(provider: Info): Info {
  return JSON.parse(
    JSON.stringify(
      {
        ...provider,
        models: Object.fromEntries(Object.entries(provider.models).filter(([, model]) => Schema.is(Model)(model))),
      },
      (_, value) => {
        if (typeof value === "function" || typeof value === "symbol" || value === undefined) return undefined
        if (typeof value === "bigint") return value.toString()
        return value
      },
    ),
  )
}

export function defaultModelIDs<T extends { models: Record<string, { id: string }> }>(providers: Record<string, T>) {
  return mapValues(providers, (item) => sort(Object.values(item.models))[0].id)
}

export class ModelNotFoundError extends Schema.TaggedErrorClass<ModelNotFoundError>()("ProviderModelNotFoundError", {
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  suggestions: Schema.optional(Schema.Array(Schema.String)),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    const suggestions = this.suggestions?.length ? ` Did you mean: ${this.suggestions.join(", ")}?` : ""
    return `Model not found: ${this.providerID}/${this.modelID}.${suggestions}`
  }

  static isInstance(input: unknown): input is ModelNotFoundError {
    return input instanceof ModelNotFoundError
  }
}

export class InitError extends Schema.TaggedErrorClass<InitError>()("ProviderInitError", {
  providerID: ProviderV2.ID,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Failed to initialize provider: ${this.providerID}`
  }

  static isInstance(input: unknown): input is InitError {
    return input instanceof InitError
  }
}

export class NoProvidersError extends Schema.TaggedErrorClass<NoProvidersError>()("ProviderNoProvidersError", {}) {
  override get message() {
    return "No providers are configured. Add a provider to the `provider` section of your config"
  }

  static isInstance(input: unknown): input is NoProvidersError {
    return input instanceof NoProvidersError
  }
}

export class NoModelsError extends Schema.TaggedErrorClass<NoModelsError>()("ProviderNoModelsError", {
  providerID: ProviderV2.ID,
}) {
  override get message() {
    return `No models are available for provider: ${this.providerID}`
  }

  static isInstance(input: unknown): input is NoModelsError {
    return input instanceof NoModelsError
  }
}

export type DefaultModelError = ModelNotFoundError | NoProvidersError | NoModelsError
export type Error = ModelNotFoundError | InitError | NoProvidersError | NoModelsError

export interface Interface {
  readonly list: () => Effect.Effect<Record<ProviderV2.ID, Info>>
  readonly getProvider: (providerID: ProviderV2.ID) => Effect.Effect<Info>
  readonly getModel: (providerID: ProviderV2.ID, modelID: ModelV2.ID) => Effect.Effect<Model, ModelNotFoundError>
  readonly getLanguage: (model: Model) => Effect.Effect<LanguageModelV3, ModelNotFoundError>
  readonly closest: (
    providerID: ProviderV2.ID,
    query: string[],
  ) => Effect.Effect<{ providerID: ProviderV2.ID; modelID: string } | undefined>
  readonly getSmallModel: (providerID: ProviderV2.ID) => Effect.Effect<Model | undefined>
  readonly defaultModel: () => Effect.Effect<{ providerID: ProviderV2.ID; modelID: ModelV2.ID }, DefaultModelError>
}

type SDK = { languageModel(modelID: string): LanguageModelV3 }

interface State {
  models: Map<string, LanguageModelV3>
  providers: Record<ProviderV2.ID, Info>
  sdk: Map<string, SDK>
}

export class Service extends Context.Service<Service, Interface>()("@cliagent/Provider") {}

export const use = serviceUse(Service)

type ConfigProvider = NonNullable<ConfigV1.Info["provider"]>[string]
type ConfigModel = NonNullable<ConfigProvider["models"]>[string]

function fromConfigModel(providerID: string, provider: ConfigProvider, modelID: string, model: ConfigModel): Model {
  const apiID = model.id ?? modelID
  const parsed: Model = {
    id: ModelV2.ID.make(modelID),
    providerID: ProviderV2.ID.make(providerID),
    api: {
      id: apiID,
      npm: SDK_PACKAGE,
      url: model.provider?.api ?? provider.api ?? "",
    },
    status: model.status ?? "active",
    name: model.name ?? modelID,
    capabilities: {
      temperature: model.temperature ?? false,
      reasoning: model.reasoning ?? false,
      attachment: model.attachment ?? false,
      toolcall: model.tool_call ?? true,
      input: {
        text: model.modalities?.input?.includes("text") ?? true,
        audio: model.modalities?.input?.includes("audio") ?? false,
        image: model.modalities?.input?.includes("image") ?? false,
        video: model.modalities?.input?.includes("video") ?? false,
        pdf: model.modalities?.input?.includes("pdf") ?? false,
      },
      output: {
        text: model.modalities?.output?.includes("text") ?? true,
        audio: model.modalities?.output?.includes("audio") ?? false,
        image: model.modalities?.output?.includes("image") ?? false,
        video: model.modalities?.output?.includes("video") ?? false,
        pdf: model.modalities?.output?.includes("pdf") ?? false,
      },
      interleaved:
        (typeof model.interleaved === "string" ? { field: model.interleaved } : model.interleaved) ??
        (apiID.includes("deepseek") ? { field: "reasoning_content" } : false),
    },
    cost: {
      input: model.cost?.input ?? 0,
      output: model.cost?.output ?? 0,
      cache: {
        read: model.cost?.cache_read ?? 0,
        write: model.cost?.cache_write ?? 0,
      },
    },
    options: model.options ?? {},
    limit: {
      context: model.limit?.context ?? 0,
      input: model.limit?.input,
      output: model.limit?.output ?? 0,
    },
    headers: model.headers ?? {},
    family: model.family ?? "",
    release_date: model.release_date ?? "",
    variants: {},
  }
  const merged = mergeDeep(ProviderTransform.variants(parsed), model.variants ?? {})
  parsed.variants = mapValues(
    pickBy(merged, (v) => !v.disabled),
    (v) => omit(v, ["disabled"]),
  )
  return parsed
}

function modelSuggestions(provider: Info | undefined, modelID: ModelV2.ID, enableExperimentalModels: boolean) {
  const available = provider
    ? Object.keys(provider.models).filter((id) => {
        const model = provider.models[id]
        if (model.status === "deprecated") return false
        if (model.status === "alpha" && !enableExperimentalModels) return false
        return true
      })
    : []
  const fuzzy = fuzzysort.go(modelID, available, { limit: 3, threshold: -10000 }).map((m) => m.target)
  if (fuzzy.length) return fuzzy
  const query = modelID
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 1)
  return sortBy(
    available
      .map((id) => ({
        id,
        score: query.filter((part) => id.toLowerCase().includes(part)).length,
      }))
      .filter((item) => item.score > 0),
    [(item) => item.score, "desc"],
    [(item) => item.id, "asc"],
  )
    .slice(0, 3)
    .map((item) => item.id)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const env = yield* Env.Service
    const plugin = yield* Plugin.Service
    const runtimeFlags = yield* RuntimeFlags.Service

    const state = yield* InstanceState.make<State>(() =>
      Effect.gen(function* () {
        const bridge = yield* EffectBridge.make()
        const cfg = yield* config.get()
        // load plugins first so config() hook runs before reading cfg.provider
        const plugins = yield* plugin.list()

        const disabled = new Set(cfg.disabled_providers ?? [])
        const enabled = cfg.enabled_providers ? new Set(cfg.enabled_providers) : null
        const allowed = (providerID: string) => (!enabled || enabled.has(providerID)) && !disabled.has(providerID)

        const providers = Object.fromEntries(
          Object.entries(cfg.provider ?? {})
            .filter(([providerID]) => allowed(providerID))
            .map(([providerID, provider]): [ProviderV2.ID, Info] => [
              ProviderV2.ID.make(providerID),
              {
                id: ProviderV2.ID.make(providerID),
                name: provider.name ?? providerID,
                env: provider.env ?? [],
                options: provider.options ?? {},
                source: "config",
                models: mapValues(provider.models ?? {}, (model, modelID) =>
                  fromConfigModel(providerID, provider, modelID, model),
                ),
              },
            ]),
        ) as Record<ProviderV2.ID, Info>

        // Plugins may replace the model list of a configured provider.
        for (const hook of plugins) {
          const models = hook.provider?.models
          if (!hook.provider || !models) continue
          const providerID = ProviderV2.ID.make(hook.provider.id)
          const provider = providers[providerID]
          if (!provider) continue
          const pluginAuth = yield* auth.get(providerID).pipe(Effect.orDie)
          const next = yield* Effect.promise(() => models(toPublicInfo(provider), { auth: pluginAuth }))
          provider.models = mapValues(next, (model, id) => ({ ...model, id: ModelV2.ID.make(id), providerID }))
        }

        // API keys: env vars listed in `env`, then keys stored with `auth login`.
        const envs = yield* env.all()
        const auths = yield* auth.all().pipe(Effect.orDie)
        for (const provider of Object.values(providers)) {
          const fromEnv = provider.env.map((item) => envs[item]).find(Boolean)
          if (fromEnv) {
            provider.source = "env"
            provider.key = fromEnv
          }
          const stored = auths[provider.id]
          if (stored?.type === "api") {
            provider.source = "api"
            provider.key = stored.key
          }
        }

        // Plugins may contribute request options (e.g. custom auth headers) for a configured provider.
        for (const hook of plugins) {
          if (!hook.auth?.loader) continue
          const providerID = ProviderV2.ID.make(hook.auth.provider)
          const provider = providers[providerID]
          if (!provider) continue
          if (!(yield* auth.get(providerID).pipe(Effect.orDie))) continue
          const loader = hook.auth.loader
          const options = yield* Effect.promise(() =>
            loader(() => bridge.promise(auth.get(providerID).pipe(Effect.orDie)) as any, toPublicInfo(provider)),
          )
          provider.options = mergeDeep(provider.options, options ?? {})
        }

        for (const provider of Object.values(providers)) {
          const configProvider = cfg.provider?.[provider.id]
          provider.models = pickBy(provider.models, (model, modelID) => {
            if (model.status === "alpha" && !runtimeFlags.enableExperimentalModels) return false
            if (model.status === "deprecated") return false
            if (configProvider?.blacklist?.includes(modelID)) return false
            if (configProvider?.whitelist && !configProvider.whitelist.includes(modelID)) return false
            return true
          })
          if (Object.keys(provider.models).length === 0) delete providers[provider.id]
        }

        return {
          models: new Map<string, LanguageModelV3>(),
          providers,
          sdk: new Map<string, SDK>(),
        }
      }),
    )

    const list = Effect.fn("Provider.list")(() => InstanceState.use(state, (s) => s.providers))

    function resolveSDK(model: Model, s: State, envs: Record<string, string | undefined>) {
      try {
        const provider = s.providers[model.providerID]
        const options = { ...provider.options }
        if (options["includeUsage"] !== false) options["includeUsage"] = true

        const baseURL = iife(() => {
          const url =
            typeof options["baseURL"] === "string" && options["baseURL"] !== "" ? options["baseURL"] : model.api.url
          if (!url) return
          return url.replace(/\$\{([^}]+)\}/g, (item, key) => envs[String(key)] ?? item)
        })
        if (!baseURL) throw new Error(`Provider ${model.providerID} has no options.baseURL`)
        if (options["apiKey"] === undefined && provider.key) options["apiKey"] = provider.key
        if (model.headers) options["headers"] = { ...options["headers"], ...model.headers }

        const key = Hash.fast(JSON.stringify({ providerID: model.providerID, baseURL, options }))
        const existing = s.sdk.get(key)
        if (existing) return existing

        options["fetch"] = timeoutFetch(options)
        delete options["chunkTimeout"]
        delete options["headerTimeout"]

        // The SDK package resolves its own copy of @ai-sdk/provider, so its model type is
        // structurally the same but nominally different from the one `ai` exposes.
        const loaded = createOpenAICompatible({ ...options, name: model.providerID, baseURL }) as unknown as SDK
        s.sdk.set(key, loaded)
        return loaded
      } catch (e) {
        throw new InitError({ providerID: model.providerID, cause: e })
      }
    }

    const getProvider = Effect.fn("Provider.getProvider")((providerID: ProviderV2.ID) =>
      InstanceState.use(state, (s) => s.providers[providerID]),
    )

    const getModel = Effect.fn("Provider.getModel")(function* (providerID: ProviderV2.ID, modelID: ModelV2.ID) {
      const s = yield* InstanceState.get(state)
      const provider = s.providers[providerID]
      if (!provider) {
        const suggestions = fuzzysort
          .go(providerID, Object.keys(s.providers), { limit: 3, threshold: -10000 })
          .map((m) => m.target)
        return yield* new ModelNotFoundError({ providerID, modelID, suggestions })
      }

      const info = provider.models[modelID]
      if (!info) {
        const suggestions = modelSuggestions(provider, modelID, runtimeFlags.enableExperimentalModels)
        return yield* new ModelNotFoundError({ providerID, modelID, suggestions })
      }
      return info
    })

    const getLanguage = Effect.fn("Provider.getLanguage")(function* (model: Model) {
      const s = yield* InstanceState.get(state)
      const envs = yield* env.all()
      const key = `${model.providerID}/${model.id}`
      if (s.models.has(key)) return s.models.get(key)!

      return yield* EffectPromise.refineRejection(
        async () => {
          const language = resolveSDK(model, s, envs).languageModel(model.api.id)
          s.models.set(key, language)
          return language
        },
        (cause) =>
          cause instanceof NoSuchModelError
            ? new ModelNotFoundError({ modelID: model.id, providerID: model.providerID, cause })
            : undefined,
      )
    })

    const closest = Effect.fn("Provider.closest")(function* (providerID: ProviderV2.ID, query: string[]) {
      const s = yield* InstanceState.get(state)
      const provider = s.providers[providerID]
      if (!provider) return undefined
      for (const item of query) {
        for (const modelID of Object.keys(provider.models)) {
          if (modelID.includes(item)) return { providerID, modelID }
        }
      }
      return undefined
    })

    const getSmallModel = Effect.fn("Provider.getSmallModel")(function* (providerID: ProviderV2.ID) {
      const cfg = yield* config.get()

      if (cfg.small_model) {
        const parsed = parseModel(cfg.small_model)
        return yield* getModel(parsed.providerID, parsed.modelID).pipe(
          Effect.catchTag("ProviderModelNotFoundError", () => Effect.succeed(undefined)),
        )
      }

      const s = yield* InstanceState.get(state)
      const provider = s.providers[providerID]
      if (!provider) return undefined

      const experimental = yield* plugin.trigger<"experimental.provider.small_model">(
        "experimental.provider.small_model",
        { provider: toPublicInfo(provider) },
        { model: undefined },
      )
      if (!experimental.model) return undefined
      return {
        ...experimental.model,
        id: ModelV2.ID.make(experimental.model.id),
        providerID: ProviderV2.ID.make(experimental.model.providerID),
      }
    })

    const defaultModel = Effect.fn("Provider.defaultModel")(function* () {
      const cfg = yield* config.get()
      if (cfg.model) return parseModel(cfg.model)

      const s = yield* InstanceState.get(state)
      const recent = yield* fs.readJson(path.join(Global.Path.state, "model.json")).pipe(
        Effect.map((x): { providerID: ProviderV2.ID; modelID: ModelV2.ID }[] => {
          if (!isRecord(x) || !Array.isArray(x.recent)) return []
          return x.recent.flatMap((item) => {
            if (!isRecord(item)) return []
            if (typeof item.providerID !== "string") return []
            if (typeof item.modelID !== "string") return []
            return [{ providerID: ProviderV2.ID.make(item.providerID), modelID: ModelV2.ID.make(item.modelID) }]
          })
        }),
        Effect.catch(() => Effect.succeed([] as { providerID: ProviderV2.ID; modelID: ModelV2.ID }[])),
      )
      for (const entry of recent) {
        const provider = s.providers[entry.providerID]
        if (!provider) continue
        if (!provider.models[entry.modelID]) continue
        return { providerID: entry.providerID, modelID: entry.modelID }
      }

      const provider = Object.values(s.providers)[0]
      if (!provider) return yield* new NoProvidersError()
      const [model] = sort(Object.values(provider.models))
      if (!model) return yield* new NoModelsError({ providerID: provider.id })
      return {
        providerID: provider.id,
        modelID: model.id,
      }
    })

    return Service.of({ list, getProvider, getModel, getLanguage, closest, getSmallModel, defaultModel })
  }),
)

export function sort<T extends { id: string }>(models: T[]) {
  return sortBy(models, [(model) => (model.id.includes("latest") ? 0 : 1), "asc"], [(model) => model.id, "desc"])
}

export function parseModel(model: string) {
  const [providerID, ...rest] = model.split("/")
  return {
    providerID: ProviderV2.ID.make(providerID),
    modelID: ModelV2.ID.make(rest.join("/")),
  }
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Config.node, Auth.node, Env.node, Plugin.node, RuntimeFlags.node],
})

export * as Provider from "./provider"
