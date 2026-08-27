import type { AnalysisResult, Finding } from '../types.js'

/**
 * Machine-readable output.
 *
 * Versioned from the first release. A CI integration that parses this is a
 * consumer we cannot see and cannot migrate, so the shape is treated as a
 * contract: fields get added, never renamed or repurposed.
 */

export const JSON_REPORT_VERSION = 1

export type JsonFinding = {
  kind: Finding['kind']
  severity: Finding['severity']
  message: string
  file: string
  line: number
  column: number
  fingerprint: string
  method: string
  pattern: string | null
  /** Only present on broken calls. */
  reason?: string
  /** Only present on method mismatches. */
  methodsAtPattern?: string[]
  /** Original source text, for broken and unresolved findings. */
  source?: string
}

export type JsonReport = {
  version: number
  tool: 'routedrift'
  root: string
  summary: {
    errors: number
    warnings: number
    unresolved: number
    routes: number
    callSites: number
    externalCallSites: number
    suppressedDeadRoutes: number
    baselined: number
  }
  coverage: AnalysisResult['coverage']
  findings: JsonFinding[]
  routes: AnalysisResult['routes']
}

export function toJsonReport(result: AnalysisResult): JsonReport {
  return {
    version: JSON_REPORT_VERSION,
    tool: 'routedrift',
    root: result.root,
    summary: {
      errors: result.stats.errors,
      warnings: result.stats.warnings,
      unresolved: result.stats.infos,
      routes: result.stats.routes,
      callSites: result.stats.callSites,
      externalCallSites: result.stats.externalCallSites,
      suppressedDeadRoutes: result.stats.suppressedDeadRoutes,
      baselined: result.stats.baselined,
    },
    coverage: result.coverage,
    findings: result.findings.map(toJsonFinding),
    routes: result.routes,
  }
}

function toJsonFinding(finding: Finding): JsonFinding {
  const base = {
    kind: finding.kind,
    severity: finding.severity,
    message: finding.message,
    file: finding.file,
    line: finding.line,
    column: finding.column,
    fingerprint: finding.fingerprint,
  }

  if (finding.kind === 'dead') {
    return { ...base, method: finding.route.method, pattern: finding.route.pattern }
  }

  if (finding.kind === 'broken') {
    return {
      ...base,
      method: finding.call.method,
      pattern: finding.call.pattern,
      reason: finding.reason,
      methodsAtPattern: finding.methodsAtPattern,
      source: finding.call.raw,
    }
  }

  return {
    ...base,
    method: finding.call.method,
    pattern: null,
    reason: finding.call.reason ?? 'dynamic-expression',
    source: finding.call.raw,
  }
}

export function reportToJson(result: AnalysisResult): string {
  return JSON.stringify(toJsonReport(result), null, 2)
}
