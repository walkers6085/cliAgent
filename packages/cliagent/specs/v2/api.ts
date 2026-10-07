// @ts-nocheck

import { cliAgent } from "@cliagent/core"
import { ReadTool } from "@cliagent/core/tools"

const cliagent = cliAgent.make({})

cliagent.tool.add(ReadTool)

cliagent.tool.add({
  name: "bash",
  schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run.",
      },
    },
    required: ["command"],
  },
  execute(input, ctx) {},
})

cliagent.auth.add({
  provider: "openai",
  type: "api",
  value: process.env.OPENAI_API_KEY,
})

cliagent.agent.add({
  name: "build",
  permissions: [],
  model: {
    id: "gpt-5-5",
    provider: "openai",
    variant: "xhigh",
  },
})

const sessionID = await cliagent.session.create({
  agent: "build",
})

cliagent.subscribe((event) => {
  console.log(event)
})

await cliagent.session.prompt({
  sessionID,
  text: "hey what is up",
})

await cliagent.session.prompt({
  sessionID,
  text: "what is up with this",
  files: [
    {
      mime: "image/png",
      uri: "data:image/png;base64,xxxx",
    },
  ],
})

await cliagent.session.wait()

console.log(await cliagent.session.messages(sessionID))
