import { afterEach, expect } from "bun:test"
import { LayerNode } from "@cliagent/core/effect/layer-node"
import { Effect } from "effect"
import { FSUtil } from "@cliagent/core/fs-util"
import { disposeAllInstances } from "../fixture/fixture"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { Provider } from "@/provider/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@cliagent/core/provider"
import { ModelV2 } from "@cliagent/core/model"

const originalEnv = new Map<string, string | undefined>()

const setProcessEnv = (k: string, v: string) =>
  Effect.sync(() => {
    if (!originalEnv.has(k)) originalEnv.set(k, process.env[k])
    process.env[k] = v
  })

afterEach(async () => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  originalEnv.clear()
  await disposeAllInstances()
})

const providerLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([Provider.node, FSUtil.node, Env.node, Config.node, Auth.node, Plugin.node, RuntimeFlags.node]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(providerLayer())
const experimentalModels = testEffect(providerLayer({ enableExperimentalModels: true }))

const list = Provider.use.list()
const mistral = ProviderV2.ID.make("mistral")

const mistralConfig = {
  provider: {
    mistral: {
      name: "Mistral",
      env: ["CLIAGENT_TEST_MISTRAL_KEY"],
      options: { baseURL: "https://api.mistral.ai/v1" },
      models: {
        "mistral-medium-latest": { name: "Mistral Medium" },
        "mistral-small-latest": {},
        "mistral-alpha": { status: "alpha" as const },
      },
    },
  },
}

it.instance("has no providers without config", () =>
  Effect.gen(function* () {
    yield* setProcessEnv("OPENAI_API_KEY", "sk-test")
    yield* setProcessEnv("ANTHROPIC_API_KEY", "sk-test")
    expect(Object.keys(yield* list)).toEqual([])
  }),
)

it.instance("defaultModel fails with NoProvidersError without config", () =>
  Effect.gen(function* () {
    const exit = yield* Provider.use.defaultModel().pipe(Effect.flip)
    expect(exit._tag).toBe("ProviderNoProvidersError")
  }),
)

it.instance(
  "loads providers only from config, always through the OpenAI-compatible SDK",
  () =>
    Effect.gen(function* () {
      const providers = yield* list
      expect(Object.keys(providers)).toEqual(["mistral"])
      const model = providers[mistral].models["mistral-medium-latest"]
      expect(model.name).toBe("Mistral Medium")
      expect(model.api.npm).toBe(Provider.SDK_PACKAGE)
      expect(providers[mistral].models["mistral-small-latest"].name).toBe("mistral-small-latest")
    }),
  { config: mistralConfig },
)

it.instance(
  "ignores a custom npm package and still uses the OpenAI-compatible SDK",
  () =>
    Effect.gen(function* () {
      const providers = yield* list
      expect(providers[ProviderV2.ID.make("custom")].models.m.api.npm).toBe(Provider.SDK_PACKAGE)
    }),
  {
    config: {
      provider: {
        custom: { npm: "@ai-sdk/anthropic", options: { baseURL: "https://example.com/v1" }, models: { m: {} } },
      },
    },
  },
)

it.instance(
  "filters alpha models by default",
  () =>
    Effect.gen(function* () {
      const providers = yield* list
      expect(providers[mistral].models["mistral-alpha"]).toBeUndefined()
    }),
  { config: mistralConfig },
)

experimentalModels.instance(
  "keeps alpha models when experimental models are enabled",
  () =>
    Effect.gen(function* () {
      const providers = yield* list
      expect(providers[mistral].models["mistral-alpha"]).toBeDefined()
    }),
  { config: mistralConfig },
)

it.instance(
  "reads the API key from the configured env variable",
  () =>
    Effect.gen(function* () {
      yield* setProcessEnv("CLIAGENT_TEST_MISTRAL_KEY", "env-key")
      yield* Env.use.set("CLIAGENT_TEST_MISTRAL_KEY", "env-key")
      const providers = yield* list
      expect(providers[mistral].source).toBe("env")
      expect(providers[mistral].key).toBe("env-key")
    }),
  { config: mistralConfig },
)

it.instance(
  "respects disabled_providers",
  () =>
    Effect.gen(function* () {
      expect((yield* list)[mistral]).toBeUndefined()
    }),
  { config: { ...mistralConfig, disabled_providers: ["mistral"] } },
)

it.instance(
  "respects whitelist and blacklist",
  () =>
    Effect.gen(function* () {
      const models = Object.keys((yield* list)[mistral].models)
      expect(models).toEqual(["mistral-medium-latest"])
    }),
  {
    config: {
      provider: {
        mistral: { ...mistralConfig.provider.mistral, blacklist: ["mistral-small-latest"] },
      },
    },
  },
)

it.instance(
  "drops providers without models",
  () =>
    Effect.gen(function* () {
      expect((yield* list)[ProviderV2.ID.make("empty")]).toBeUndefined()
    }),
  { config: { provider: { empty: { options: { baseURL: "https://example.com/v1" } } } } },
)

it.instance(
  "getModel suggests close model ids",
  () =>
    Effect.gen(function* () {
      const error = yield* Provider.use.getModel(mistral, ModelV2.ID.make("mistral-medium")).pipe(Effect.flip)
      expect(error.suggestions).toContain("mistral-medium-latest")
    }),
  { config: mistralConfig },
)

it.instance(
  "defaultModel uses the config model, then the first configured provider",
  () =>
    Effect.gen(function* () {
      const model = yield* Provider.use.defaultModel()
      expect(model.providerID).toBe(mistral)
      expect(model.modelID).toBe(ModelV2.ID.make("mistral-small-latest"))
    }),
  { config: { ...mistralConfig, model: "mistral/mistral-small-latest" } },
)

it.instance(
  "getLanguage builds an OpenAI-compatible model with the configured baseURL",
  () =>
    Effect.gen(function* () {
      const model = yield* Provider.use.getModel(mistral, ModelV2.ID.make("mistral-medium-latest"))
      const language = yield* Provider.use.getLanguage(model)
      expect(language.provider).toContain("mistral")
      expect(language.modelId).toBe("mistral-medium-latest")
    }),
  { config: mistralConfig },
)
