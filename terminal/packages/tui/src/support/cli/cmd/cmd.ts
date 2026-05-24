import type { CommandModule } from "yargs"

export function cmd<T = unknown, U = unknown>(module: CommandModule<T, U>): CommandModule<T, U> {
  return module
}
