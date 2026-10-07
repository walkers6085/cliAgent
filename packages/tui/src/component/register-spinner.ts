import { getComponentCatalogue } from "@opentui/solid/components"
import { registerSpinner } from "opentui-spinner/solid"

export function registerCliAgentSpinner() {
  if (!getComponentCatalogue().spinner) registerSpinner()
}
