/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeCliAgentContent from "./skill/customize-cliagent.md" with { type: "text" }

export const CustomizeCliAgentContent = customizeCliAgentContent

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((draft) => {
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "customize-cliagent",
            description:
              "Use ONLY when the user is editing or creating cliagent's own configuration: cliagent.json, cliagent.jsonc, files under .cliagent/, or files under ~/.config/cliagent/. Also use when creating or fixing cliagent agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring cliagent itself.",
            location: AbsolutePath.make("/builtin/customize-cliagent.md"),
            content: CustomizeCliAgentContent,
          }),
        }),
      )
    })
  }),
})
