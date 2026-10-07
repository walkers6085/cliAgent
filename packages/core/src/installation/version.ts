declare global {
  const CLIAGENT_VERSION: string
  const CLIAGENT_CHANNEL: string
}

export const InstallationVersion = typeof CLIAGENT_VERSION === "string" ? CLIAGENT_VERSION : "local"
export const InstallationChannel = typeof CLIAGENT_CHANNEL === "string" ? CLIAGENT_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
