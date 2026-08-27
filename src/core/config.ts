import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { HTTP_METHODS, isHttpMethod, type HttpMethod } from '../types.js'

export type FailOn = 'error' | 'warn' | 'never'

export type RoutedriftConfig = {
  /** Globs, relative to the root, of files scanned for call sites. */
  include: string[]
  /** Globs excluded from every kind of scanning. */
  exclude: string[]
  /** Which backend extractors to run. */
  frameworks: string[]
  /**
   * Origins that belong to this application. An absolute URL pointing at one of
   * these is checked; anything else is treated as a third-party API and ignored.
   */
  baseUrls: string[]
  /**
   * Findings to suppress. Each entry is either a file glob
   * (`src/legacy/**`) or an endpoint (`GET /api/health`, `* /api/internal/**`).
   */
  ignore: string[]
  /** Routes that should never be reported as dead, e.g. webhook receivers. */
  ignoreRoutes: string[]
  failOn: FailOn
  reportDeadRoutes: boolean
  /**
   * Methods eligible for a dead-route warning. `HEAD` and `OPTIONS` are excluded
   * by default because they are called by browsers and proxies, not by app code,
   * so flagging them as unused is almost always noise.
   */
  deadRouteMethods: HttpMethod[]
}

export const DEFAULT_CONFIG: RoutedriftConfig = {
  include: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
  exclude: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/out/**',
    '**/.next/**',
    '**/.turbo/**',
    '**/.svelte-kit/**',
    '**/coverage/**',
    '**/*.d.ts',
    '**/*.min.js',
  ],
  frameworks: ['nextjs'],
  baseUrls: [],
  ignore: [],
  ignoreRoutes: [],
  failOn: 'error',
  reportDeadRoutes: true,
  deadRouteMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
}

const CONFIG_FILENAMES = [
  'routedrift.config.json',
  'routedrift.config.js',
  'routedrift.config.mjs',
  '.routedriftrc.json',
  '.routedriftrc',
]

export class ConfigError extends Error {}

/** Where the effective config came from — echoed by `--json` so runs are reproducible. */
export type ConfigSource = { path: string | null; kind: 'file' | 'package.json' | 'defaults' }

export type LoadedConfig = { config: RoutedriftConfig; source: ConfigSource }

export async function loadConfig(
  root: string,
  overrides: Partial<RoutedriftConfig> = {},
  explicitPath?: string,
): Promise<LoadedConfig> {
  const found = explicitPath
    ? { file: path.resolve(root, explicitPath), kind: 'file' as const }
    : discover(root)

  let fromFile: Partial<RoutedriftConfig> = {}
  let source: ConfigSource = { path: null, kind: 'defaults' }

  if (found) {
    if (explicitPath && !fs.existsSync(found.file)) {
      throw new ConfigError(`config file not found: ${found.file}`)
    }
    fromFile = await read(found.file, found.kind)
    source = { path: found.file, kind: found.kind }
  }

  const merged: RoutedriftConfig = {
    ...DEFAULT_CONFIG,
    ...clean(fromFile),
    ...clean(overrides),
  }

  validate(merged)
  return { config: merged, source }
}

function discover(root: string): { file: string; kind: 'file' | 'package.json' } | null {
  for (const name of CONFIG_FILENAMES) {
    const candidate = path.join(root, name)
    if (fs.existsSync(candidate)) return { file: candidate, kind: 'file' }
  }

  const pkg = path.join(root, 'package.json')
  if (fs.existsSync(pkg)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(pkg, 'utf8'))
      if (isRecord(parsed) && isRecord(parsed.routedrift)) {
        return { file: pkg, kind: 'package.json' }
      }
    } catch {
      // A malformed package.json is not our problem to report.
    }
  }

  return null
}

async function read(file: string, kind: 'file' | 'package.json'): Promise<Partial<RoutedriftConfig>> {
  if (kind === 'package.json') {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (isRecord(parsed) && isRecord(parsed.routedrift)) {
      return parsed.routedrift as Partial<RoutedriftConfig>
    }
    return {}
  }

  if (file.endsWith('.js') || file.endsWith('.mjs')) {
    const loaded: unknown = await import(pathToFileURL(file).href)
    const value = isRecord(loaded) && 'default' in loaded ? loaded.default : loaded
    if (!isRecord(value)) throw new ConfigError(`${file} must export an object`)
    return value as Partial<RoutedriftConfig>
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new ConfigError(`could not parse ${file}: ${(error as Error).message}`)
  }
  if (!isRecord(parsed)) throw new ConfigError(`${file} must contain a JSON object`)
  return parsed as Partial<RoutedriftConfig>
}

/** Drop `undefined` values so that spreading an override object cannot erase a default. */
function clean(value: Partial<RoutedriftConfig>): Partial<RoutedriftConfig> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<RoutedriftConfig>
}

function validate(config: RoutedriftConfig): void {
  for (const key of ['include', 'exclude', 'frameworks', 'baseUrls', 'ignore', 'ignoreRoutes'] as const) {
    const value = config[key]
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
      throw new ConfigError(`config.${key} must be an array of strings`)
    }
  }

  if (!['error', 'warn', 'never'].includes(config.failOn)) {
    throw new ConfigError(`config.failOn must be one of error, warn, never`)
  }

  if (typeof config.reportDeadRoutes !== 'boolean') {
    throw new ConfigError('config.reportDeadRoutes must be a boolean')
  }

  if (!Array.isArray(config.deadRouteMethods) || !config.deadRouteMethods.every(m => typeof m === 'string' && isHttpMethod(m))) {
    throw new ConfigError(
      `config.deadRouteMethods must contain only: ${HTTP_METHODS.join(', ')}`,
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
