import { Context } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type { WorkspaceV2 } from "@cliagent/core/workspace"

export const InstanceRef = Context.Reference<InstanceContext | undefined>("~cliagent/InstanceRef", {
  defaultValue: () => undefined,
})

export const WorkspaceRef = Context.Reference<WorkspaceV2.ID | undefined>("~cliagent/WorkspaceRef", {
  defaultValue: () => undefined,
})
