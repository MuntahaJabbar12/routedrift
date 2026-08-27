#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from './index.js'
import { ConfigError, loadConfig, type FailOn, type RoutedriftConfig } from './core/config.js'
import {
  BaselineError,
  DEFAULT_BASELINE_FILE,
  baselineFrom,
  readBaseline,
  writeBaseline,
} from './core/baseline.js'
import { reportToTerminal } from './reporter/cli.js'
import { reportToJson } from './reporter/json.js'
import { shouldColor } from './reporter/color.js'

/**
 * Exit codes are part of the interface: 0 clean, 1 findings at or above the
 * threshold, 2 the tool itself could not run. CI needs to tell "your code has
 * drift" apart from "the linter crashed", and collapsing those into 1 is how a
 * check ends up permanently disabled.
 */
const EXIT_OK = 0
const EXIT_FINDINGS = 1
const EXIT_ERROR = 2

const VERSION = readVersion()

const USAGE = `routedrift — find API contract drift between frontend calls and backend routes

Usage
  routedrift [path] [options]

Options
  --json                  Emit a machine-readable report on stdout
  --fail-on <level>       error (default) | warn | never
  --strict                Shorthand for --fail-on warn
  --ignore <pattern>      Suppress findings; repeatable.
                          Accepts a file glob (src/legacy/**) or an
                          endpoint (GET /api/health, "* /api/internal/**")
  --config <file>         Path to a config file
  --baseline [file]       Compare against a baseline (default ${DEFAULT_BASELINE_FILE})
  --update-baseline       Write the current findings to the baseline and exit 0
  --no-dead-routes        Do not report unused backend routes
  --quiet                 Hide unresolved call sites; still report coverage
  --no-color              Disable colour
  -h, --help              Show this message
  -v, --version           Show the version

Examples
  routedrift
  routedrift ./apps/web --strict
  routedrift --json > routedrift.json
  routedrift --ignore "GET /api/health" --ignore "src/generated/**"
  routedrift --update-baseline && git add ${DEFAULT_BASELINE_FILE}
`

type Options = {
  dir: string
  json: boolean
  quiet: boolean
  color: boolean
  configPath?: string
  baselinePath?: string
  updateBaseline: boolean
  overrides: Partial<RoutedriftConfig>
}

class UsageError extends Error {}

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    dir: '.',
    json: false,
    quiet: false,
    color: shouldColor(),
    updateBaseline: false,
    overrides: {},
  }

  const ignore: string[] = []
  let positional: string | null = null

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!

    switch (arg) {
      case '--json':
        options.json = true
        break
      case '--quiet':
        options.quiet = true
        break
      case '--no-color':
        options.color = false
        break
      case '--color':
        options.color = true
        break
      case '--strict':
        options.overrides.failOn = 'warn'
        break
      case '--no-dead-routes':
        options.overrides.reportDeadRoutes = false
        break
      case '--update-baseline':
        options.updateBaseline = true
        break
      case '--fail-on': {
        const value = argv[++i]
        if (!value || !['error', 'warn', 'never'].includes(value)) {
          throw new UsageError('--fail-on expects one of: error, warn, never')
        }
        options.overrides.failOn = value as FailOn
        break
      }
      case '--ignore': {
        const value = argv[++i]
        if (!value) throw new UsageError('--ignore expects a pattern')
        ignore.push(value)
        break
      }
      case '--config': {
        const value = argv[++i]
        if (!value) throw new UsageError('--config expects a file path')
        options.configPath = value
        break
      }
      case '--baseline': {
        // The path is optional, so only consume the next token if it is not a flag.
        const next = argv[i + 1]
        options.baselinePath = next && !next.startsWith('-') ? argv[++i] : DEFAULT_BASELINE_FILE
        break
      }
      default: {
        if (arg.startsWith('-')) throw new UsageError(`unknown option: ${arg}`)
        if (positional !== null) throw new UsageError(`unexpected argument: ${arg}`)
        positional = arg
      }
    }
  }

  if (positional !== null) options.dir = positional
  if (ignore.length > 0) options.overrides.ignore = ignore

  return options
}

export async function run(argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(USAGE)
    return EXIT_OK
  }

  if (argv.includes('-v') || argv.includes('--version')) {
    process.stdout.write(VERSION + '\n')
    return EXIT_OK
  }

  const options = parseArgs(argv)
  const root = path.resolve(options.dir)

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new UsageError(`not a directory: ${options.dir}`)
  }

  const { config } = await loadConfig(root, options.overrides, options.configPath)

  // Writing a baseline means recording everything, so the run that produces it
  // must not itself be filtered by the old one.
  const baselineFile = options.baselinePath ? path.resolve(root, options.baselinePath) : null
  const baseline =
    baselineFile && !options.updateBaseline ? readBaseline(baselineFile) : null

  const result = analyze(root, { config, baseline })

  if (options.updateBaseline) {
    const target = baselineFile ?? path.resolve(root, DEFAULT_BASELINE_FILE)
    writeBaseline(target, baselineFrom(result.findings))
    process.stdout.write(
      `Wrote ${result.findings.length} finding(s) to ${path.relative(process.cwd(), target) || target}\n`,
    )
    return EXIT_OK
  }

  if (options.json) {
    process.stdout.write(reportToJson(result) + '\n')
  } else {
    process.stdout.write(
      reportToTerminal(result, { color: options.color, quiet: options.quiet }) + '\n',
    )
  }

  return exitCodeFor(config.failOn, result.stats.errors, result.stats.warnings)
}

export function exitCodeFor(failOn: FailOn, errors: number, warnings: number): number {
  if (failOn === 'never') return EXIT_OK
  if (failOn === 'warn') return errors + warnings > 0 ? EXIT_FINDINGS : EXIT_OK
  return errors > 0 ? EXIT_FINDINGS : EXIT_OK
}

function readVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    for (const candidate of [
      path.resolve(here, '../package.json'),
      path.resolve(here, '../../package.json'),
    ]) {
      if (!fs.existsSync(candidate)) continue
      const parsed: unknown = JSON.parse(fs.readFileSync(candidate, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
        const version = (parsed as { version?: unknown }).version
        if (typeof version === 'string') return version
      }
    }
  } catch {
    // Falling through to "unknown" is better than failing to start.
  }
  return 'unknown'
}

/** Only run when invoked as a binary, so tests can import `run` freely. */
const invokedDirectly =
  process.argv[1] !== undefined &&
  ['routedrift', 'cli.js', 'cli.ts'].some(name => process.argv[1]!.endsWith(name))

if (invokedDirectly) {
  run(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)

      if (error instanceof UsageError) {
        process.stderr.write(`routedrift: ${message}\n\nRun routedrift --help for usage.\n`)
      } else if (error instanceof ConfigError || error instanceof BaselineError) {
        process.stderr.write(`routedrift: ${message}\n`)
      } else {
        process.stderr.write(`routedrift: unexpected error: ${message}\n`)
        if (process.env.ROUTEDRIFT_DEBUG) process.stderr.write(String((error as Error)?.stack) + '\n')
      }

      process.exit(EXIT_ERROR)
    })
}
