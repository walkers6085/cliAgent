import { AgentV2 } from "@cliagent/core/agent"
import { AISDK } from "@cliagent/core/aisdk"
import { Catalog } from "@cliagent/core/catalog"
import { CommandV2 } from "@cliagent/core/command"
import { Credential } from "@cliagent/core/credential"
import { AppNodeBuilder } from "@cliagent/core/effect/app-node-builder"
import { LayerNodePlatform } from "@cliagent/core/effect/app-node-platform"
import { LayerNode } from "@cliagent/core/effect/layer-node"
import { EventV2 } from "@cliagent/core/event"
import { FileSystem } from "@cliagent/core/filesystem"
import { FSUtil } from "@cliagent/core/fs-util"
import { Integration } from "@cliagent/core/integration"
import { Location } from "@cliagent/core/location"
import { Npm } from "@cliagent/core/npm"
import { PluginV2 } from "@cliagent/core/plugin"
import { Reference } from "@cliagent/core/reference"
import { SkillV2 } from "@cliagent/core/skill"
import { Effect, Layer } from "effect"
import { tempLocationLayer } from "../fixture/location"

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: () => Effect.succeed({ directory: "", entrypoint: undefined }),
    install: () => Effect.void,
    which: () => Effect.succeed(undefined),
  }),
)

export const PluginTestLayer = AppNodeBuilder.build(
  LayerNode.group([
    FileSystem.node,
    FSUtil.node,
    Location.node,
    Npm.node,
    Credential.node,
    EventV2.node,
    LayerNodePlatform.httpClient,
    PluginV2.node,
    AgentV2.node,
    AISDK.node,
    Catalog.node,
    CommandV2.node,
    Integration.node,
    Reference.node,
    SkillV2.node,
  ]),
  [
    [Location.node, tempLocationLayer],
    [Npm.node, npmLayer],
  ],
)
