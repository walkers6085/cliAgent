import { describe, expect, test } from "bun:test"
import { LLM, LLMClient, Provider } from "@cliagent/llm"
import { Route, Protocol } from "@cliagent/llm/route"
import { Provider as ProviderSubpath } from "@cliagent/llm/provider"
import { OpenAICompatible } from "@cliagent/llm/providers"
import { OpenAIChat, OpenAICompatibleChat } from "@cliagent/llm/protocols"

describe("public exports", () => {
  test("root exposes app-facing runtime APIs", () => {
    expect(LLM.request).toBeFunction()
    expect(LLMClient.Service).toBeFunction()
    expect(LLMClient.layer).toBeDefined()
    expect(Provider.make).toBeFunction()
    expect(ProviderSubpath.make).toBe(Provider.make)
  })

  test("route barrel exposes route-authoring APIs", () => {
    expect(Route.make).toBeFunction()
    expect(Protocol.make).toBeFunction()
  })

  test("provider barrel exposes the OpenAI-compatible facade", () => {
    expect(OpenAICompatible.deepseek.model).toBeFunction()
  })

  test("protocol barrels expose supported low-level routes", () => {
    expect(OpenAIChat.route.id).toBe("openai-chat")
    expect(OpenAICompatibleChat.route.id).toBe("openai-compatible-chat")
  })
})
