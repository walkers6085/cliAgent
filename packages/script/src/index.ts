import { $ } from "bun"
import semver from "semver"
import path from "path"

const rootPkg = await Bun.file(path.resolve(import.meta.dir, "../../../package.json")).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
if (!semver.satisfies(process.versions.bun, `^${expectedBunVersion}`)) {
  throw new Error(`This script requires bun@^${expectedBunVersion}, but you are using bun@${process.versions.bun}`)
}

const cliPkg = await Bun.file(path.resolve(import.meta.dir, "../../cliagent/package.json")).json()

const CHANNEL =
  process.env["CLIAGENT_CHANNEL"] ??
  ((await $`git branch --show-current`.nothrow().text()).trim() || "local")

// The version comes from packages/cliagent/package.json unless CLIAGENT_VERSION overrides it.
const VERSION: string = process.env["CLIAGENT_VERSION"] ?? cliPkg.version

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
}
console.log(`cliagent script`, JSON.stringify(Script, null, 2))
