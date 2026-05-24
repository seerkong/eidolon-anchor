#!/usr/bin/env bun
/**
 * Cross-platform install script for eidolon CLI
 */

import { existsSync, mkdirSync, copyFileSync, symlinkSync, unlinkSync, lstatSync } from "fs"
import { dirname, join, resolve } from "path"
import { homedir, platform } from "os"

const isWindows = platform() === "win32"
const projectRoot = resolve(import.meta.dir, "..")
const exeName = isWindows ? "eidolon.exe" : "eidolon"
const sourcePath = join(projectRoot, "dist", "terminal", "cli", exeName)

type CliOptions = {
  help: boolean
  targetPath?: string
}

function expandHome(inputPath: string): string {
  if (inputPath === "~") {
    return homedir()
  }
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return join(homedir(), inputPath.slice(2))
  }
  return inputPath
}

function usage(): never {
  console.log(`Usage: bun run scripts/install-dist-cli.ts [options]

Options:
  --target-path PATH   Override the installed path. Defaults to EIDOLON_CLI_BIN_PATH or /Users/kongweixian/bin/eidolon-cli.
  --help               Show this help text.`)
  process.exit(0)
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { help: false }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case "--help":
      case "-h":
        options.help = true
        break
      case "--target-path": {
        const value = argv[index + 1]
        if (!value) {
          console.error("Error: --target-path requires a value.")
          process.exit(1)
        }
        options.targetPath = value
        index += 1
        break
      }
      default:
        console.error(`Error: Unknown argument: ${arg}`)
        process.exit(1)
    }
  }

  return options
}

function getDefaultTargetPath(): string {
  if (process.env.EIDOLON_CLI_BIN_PATH) {
    return process.env.EIDOLON_CLI_BIN_PATH
  }

  if (isWindows) {
    return join(homedir(), ".local", "bin", "eidolon-cli.exe")
  }

  return "/Users/kongweixian/bin/eidolon-cli"
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`Created directory: ${dir}`)
  }
}

function isSymlink(targetPath: string): boolean {
  try {
    return lstatSync(targetPath).isSymbolicLink()
  } catch {
    return false
  }
}

function install(options: CliOptions): void {
  if (!existsSync(sourcePath)) {
    console.error(`Error: Source file not found: ${sourcePath}`)
    console.error("Please run 'bun run build:terminal:cli' first.")
    process.exit(1)
  }

  const targetPath = resolve(expandHome(options.targetPath ?? getDefaultTargetPath()))
  const targetDir = dirname(targetPath)
  const commandName = targetPath.split(/[/\\]/).pop() || exeName

  console.log("Installing eidolon CLI...")
  console.log(`  Source: ${sourcePath}`)
  console.log(`  Target: ${targetPath}`)

  ensureDir(targetDir)

  if (!isWindows && existsSync(targetPath) && !isSymlink(targetPath)) {
    console.error(`Error: Refusing to replace a non-symlink file: ${targetPath}`)
    process.exit(1)
  }

  if (existsSync(targetPath) || isSymlink(targetPath)) {
    unlinkSync(targetPath)
    console.log(`  Removed existing: ${targetPath}`)
  }

  if (isWindows) {
    copyFileSync(sourcePath, targetPath)
    console.log("  Copied successfully.")
  } else {
    try {
      symlinkSync(sourcePath, targetPath)
      console.log("  Symlink created successfully.")
    } catch (err: any) {
      if (err.code === "EPERM") {
        console.log("  Symlink failed, copying instead...")
        copyFileSync(sourcePath, targetPath)
        console.log("  Copied successfully.")
      } else {
        throw err
      }
    }
  }

  const pathEnv = process.env.PATH || ""
  const pathDirs = pathEnv.split(isWindows ? ";" : ":")
  const isInPath = pathDirs.some((dir) => {
    try {
      return resolve(dir) === resolve(targetDir)
    } catch {
      return false
    }
  })

  console.log()
  if (isInPath) {
    console.log(`Done! You can now run '${commandName}' from anywhere.`)
  } else {
    console.log(`Done! Add this directory to your PATH to use '${commandName}' globally:`)
    console.log()
    if (isWindows) {
      console.log("  PowerShell (current session):")
      console.log(`    $env:PATH += ";${targetDir}"`)
      console.log()
      console.log("  PowerShell (permanent, user-level):")
      console.log(`    [Environment]::SetEnvironmentVariable("PATH", $env:PATH + ";${targetDir}", "User")`)
      console.log()
      console.log("  MinGW/Git Bash (~/.bashrc or ~/.bash_profile):")
      console.log(`    export PATH="$PATH:${targetDir.replace(/\\/g, "/")}"`)
    } else {
      console.log("  Add to ~/.bashrc or ~/.zshrc:")
      console.log(`    export PATH="$PATH:${targetDir}"`)
    }
  }
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  usage()
}
install(options)
