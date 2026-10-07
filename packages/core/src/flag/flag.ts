import { Config } from "effect"

export function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = process.env["CLIAGENT_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
const fff = process.env["CLIAGENT_DISABLE_FFF"]

function enabledByExperimental(key: string) {
  return process.env[key] === undefined ? truthy("CLIAGENT_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  CLIAGENT_AUTO_HEAP_SNAPSHOT: truthy("CLIAGENT_AUTO_HEAP_SNAPSHOT"),
  CLIAGENT_GIT_BASH_PATH: process.env["CLIAGENT_GIT_BASH_PATH"],
  CLIAGENT_CONFIG: process.env["CLIAGENT_CONFIG"],
  CLIAGENT_CONFIG_CONTENT: process.env["CLIAGENT_CONFIG_CONTENT"],
  CLIAGENT_DISABLE_AUTOUPDATE: truthy("CLIAGENT_DISABLE_AUTOUPDATE"),
  CLIAGENT_ALWAYS_NOTIFY_UPDATE: truthy("CLIAGENT_ALWAYS_NOTIFY_UPDATE"),
  CLIAGENT_DISABLE_PRUNE: truthy("CLIAGENT_DISABLE_PRUNE"),
  CLIAGENT_DISABLE_TERMINAL_TITLE: truthy("CLIAGENT_DISABLE_TERMINAL_TITLE"),
  CLIAGENT_SHOW_TTFD: truthy("CLIAGENT_SHOW_TTFD"),
  CLIAGENT_DISABLE_AUTOCOMPACT: truthy("CLIAGENT_DISABLE_AUTOCOMPACT"),
  CLIAGENT_DISABLE_MODELS_FETCH: truthy("CLIAGENT_DISABLE_MODELS_FETCH"),
  CLIAGENT_DISABLE_MOUSE: truthy("CLIAGENT_DISABLE_MOUSE"),
  CLIAGENT_FAKE_VCS: process.env["CLIAGENT_FAKE_VCS"],
  CLIAGENT_SERVER_PASSWORD: process.env["CLIAGENT_SERVER_PASSWORD"],
  CLIAGENT_SERVER_USERNAME: process.env["CLIAGENT_SERVER_USERNAME"],
  CLIAGENT_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("CLIAGENT_DISABLE_FFF"),

  // Experimental
  CLIAGENT_EXPERIMENTAL_FILEWATCHER: Config.boolean("CLIAGENT_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  CLIAGENT_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("CLIAGENT_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  CLIAGENT_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("CLIAGENT_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  CLIAGENT_MODELS_URL: process.env["CLIAGENT_MODELS_URL"],
  CLIAGENT_MODELS_PATH: process.env["CLIAGENT_MODELS_PATH"],
  CLIAGENT_DB: process.env["CLIAGENT_DB"],

  CLIAGENT_WORKSPACE_ID: process.env["CLIAGENT_WORKSPACE_ID"],
  CLIAGENT_EXPERIMENTAL_WORKSPACES: enabledByExperimental("CLIAGENT_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get CLIAGENT_DISABLE_PROJECT_CONFIG() {
    return truthy("CLIAGENT_DISABLE_PROJECT_CONFIG")
  },
  get CLIAGENT_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("CLIAGENT_EXPERIMENTAL_REFERENCES")
  },
  get CLIAGENT_TUI_CONFIG() {
    return process.env["CLIAGENT_TUI_CONFIG"]
  },
  get CLIAGENT_CONFIG_DIR() {
    return process.env["CLIAGENT_CONFIG_DIR"]
  },
  get CLIAGENT_PURE() {
    return truthy("CLIAGENT_PURE")
  },
  get CLIAGENT_PERMISSION() {
    return process.env["CLIAGENT_PERMISSION"]
  },
  get CLIAGENT_PLUGIN_META_FILE() {
    return process.env["CLIAGENT_PLUGIN_META_FILE"]
  },
  get CLIAGENT_CLIENT() {
    return process.env["CLIAGENT_CLIENT"] ?? "cli"
  },
}
