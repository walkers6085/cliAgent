export * from "./client.js"
export * from "./server.js"

import { createCliAgentClient } from "./client.js"
import { createCliAgentServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createCliAgent(options?: ServerOptions) {
  const server = await createCliAgentServer({
    ...options,
  })

  const client = createCliAgentClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
