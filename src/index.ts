import path from 'node:path'
import type { AnalysisResult, Finding } from './types.js'
import {
  DEFAULT_CONFIG,
  loadConfig,
  type LoadedConfig,
  type RoutedriftConfig,
} from './core/config.js'
import { createProject } from './core/project.js'
import { extractorsFor } from './extractors/index.js'
import { scanCallSites } from './callsites/scanner.js'
import { match } from './matcher/index.js'
import { applyIgnores } from './core/filter.js'
import { applyBaseline, type Baseline } from './core/baseline.js'

export type AnalyzeOptions = {
  config?: RoutedriftConfig
  baseline?: Baseline | null
}

/**
 * Run the whole pipeline against a directory.
 *
 * extract routes -> scan call sites -> match -> filter. Each stage takes the
 * previous stage's plain data and knows nothing else about it.
 */
export function analyze(dir: string, options: AnalyzeOptions = {}): AnalysisResult {
  const root = path.resolve(dir)
  const config = options.config ?? DEFAULT_CONFIG

  const project = createProject(root, config)
  const extractors = extractorsFor(config.frameworks)

  const routes = extractors.flatMap(extractor =>
    extractor.extract({ root, project, config }),
  )

  const calls = scanCallSites(root, { project, config })
  const result = match(routes, calls, config)

  const afterIgnores = applyIgnores(result.findings, config.ignore)
  const afterBaseline = applyBaseline(afterIgnores.kept, options.baseline ?? null)

  return {
    root,
    routes,
    calls,
    findings: afterBaseline.kept,
    coverage: result.coverage,
    stats: {
      ...result.stats,
      ...recount(afterBaseline.kept),
      baselined: afterBaseline.baselined,
    },
  }
}

/** Convenience wrapper that also resolves the config file. */
export async function analyzeWithConfig(
  dir: string,
  overrides: Partial<RoutedriftConfig> = {},
  configPath?: string,
): Promise<AnalysisResult & { configSource: LoadedConfig['source'] }> {
  const root = path.resolve(dir)
  const { config, source } = await loadConfig(root, overrides, configPath)
  return { ...analyze(root, { config }), configSource: source }
}

function recount(findings: Finding[]) {
  return {
    errors: findings.filter(finding => finding.severity === 'error').length,
    warnings: findings.filter(finding => finding.severity === 'warn').length,
    infos: findings.filter(finding => finding.severity === 'info').length,
  }
}

export * from './types.js'
export { DEFAULT_CONFIG, loadConfig, ConfigError } from './core/config.js'
export type { RoutedriftConfig, FailOn } from './core/config.js'
export { EXTRACTORS, extractNextRoutes } from './extractors/index.js'
export type { Extractor, ExtractorContext } from './extractors/index.js'
export { scanCallSites } from './callsites/scanner.js'
export { resolveUrl } from './callsites/resolver.js'
export { match, patternsMatch } from './matcher/index.js'
export type { MatchResult } from './matcher/index.js'
export {
  DEFAULT_BASELINE_FILE,
  applyBaseline,
  baselineFrom,
  readBaseline,
  writeBaseline,
} from './core/baseline.js'
export type { Baseline } from './core/baseline.js'
export { reportToTerminal } from './reporter/cli.js'
export { reportToJson, toJsonReport } from './reporter/json.js'
