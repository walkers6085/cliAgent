export * as PublicEventManifest from "./public-event-manifest"

import { Event } from "@cliagent/schema/event"
import { EventManifest } from "@cliagent/schema/event-manifest"

export const Definitions = EventManifest.ServerDefinitions
export const Latest = Event.latest(Definitions)
