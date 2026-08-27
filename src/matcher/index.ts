import { createHash } from 'node:crypto'
import type {
  CallSite,
  Coverage,
  Finding,
  HttpMethod,
  Route,
  Stats,
} from '../types.js'
import { DEFAULT_CONFIG, type RoutedriftConfig } from '../core/config.js'
import { hasCatchAll, isDynamicSegment, normalizePattern } from '../core/normalize.js'
import { matchesGlob } from '../core/glob.js'

/**
 * Route[] x CallSite[] -> Finding[].
 *
 * The matcher is the part of the tool that has no idea what a framework is. It
 * receives two flat arrays of canonical data and compares them. That is the
 * payoff of the extractor boundary: this file never grew a special case for
 * Next.js, and it would not need one for Express either.
 */

function segmentsOf(pattern: string): string[] {
  return normalizePattern(pattern).split('/').filter(Boolean)
}

/**
 * Do a route pattern and a call pattern describe the same endpoint?
 *
 * A dynamic segment on *either* side matches anything. That asymmetry is
 * deliberate. `` fetch(`/api/users/${slug}`) `` might produce `/api/users/me`,
 * which a literal `/api/users/me` route serves perfectly well — so treating the
 * call's wildcard as matching only route parameters would manufacture an error
 * for correct code. The cost is that dead-route detection gets slightly more
 * cautious, and a missed warning is cheaper than a false error.
 */
export function patternsMatch(routePattern: string, callPattern: string): boolean {
  const route = segmentsOf(routePattern)
  const call = segmentsOf(callPattern)

  const routeCatchAll = hasCatchAll(routePattern)
  const callCatchAll = hasCatchAll(callPattern)

  if (!routeCatchAll && !callCatchAll && route.length !== call.length) return false

  // A catch-all consumes the rest of the path, so only the leading segments
  // before it need to line up.
  const fixed = routeCatchAll ? route.length - 1 : callCatchAll ? call.length - 1 : route.length

  if (routeCatchAll && call.length < fixed) return false
  if (callCatchAll && route.length < fixed) return false

  for (let i = 0; i < fixed; i++) {
    const routeSegment = route[i]
    const callSegment = call[i]
    if (routeSegment === undefined || callSegment === undefined) return false

    if (isDynamicSegment(routeSegment) || isDynamicSegment(callSegment)) continue
    if (routeSegment !== callSegment) return false
  }

  return true
}

/** Every pattern a call site might request. */
function candidatesOf(call: CallSite): string[] {
  return call.pattern === null ? [] : [call.pattern, ...call.alternatives]
}

/**
 * Segment-aware prefix test. Plain `startsWith` would treat `/api/admin` as a
 * prefix of `/api/administrators`, which is exactly the kind of near-miss that
 * makes a tool look careless.
 */
function isUnderPrefix(pattern: string, prefix: string): boolean {
  return pattern === prefix || pattern.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')
}

export type MatchResult = {
  findings: Finding[]
  coverage: Coverage
  stats: Stats
}

export function match(
  routes: Route[],
  calls: CallSite[],
  config: RoutedriftConfig = DEFAULT_CONFIG,
): MatchResult {
  const findings: Finding[] = []
  const usedRoutes = new Set<Route>()
  /** Routes an unresolved call might plausibly reach, by static prefix. */
  const possiblyUsedRoutes = new Set<Route>()

  const internalCalls = calls.filter(call => !call.external)
  let resolvedCalls = 0

  for (const call of internalCalls) {
    const candidates = candidatesOf(call)

    if (candidates.length === 0) {
      // Unresolved. Info severity, never fails a build, and it still earns its
      // keep: the static prefix stops us reporting routes it may reach as dead.
      if (call.staticPrefix) {
        for (const route of routes) {
          if (isUnderPrefix(route.pattern, call.staticPrefix)) possiblyUsedRoutes.add(route)
        }
      }

      findings.push(unresolvedFinding(call))
      continue
    }

    resolvedCalls++

    const pathMatches = routes.filter(route =>
      candidates.some(candidate => patternsMatch(route.pattern, candidate)),
    )

    if (pathMatches.length === 0) {
      findings.push(brokenFinding(call, 'no-route', []))
      continue
    }

    // With an unreadable verb we can only assert the path exists.
    if (!call.methodConfident) {
      for (const route of pathMatches) usedRoutes.add(route)
      continue
    }

    const methodMatches = pathMatches.filter(route => route.method === call.method)

    if (methodMatches.length === 0) {
      const available = [...new Set(pathMatches.map(route => route.method))].sort()
      findings.push(brokenFinding(call, 'method-mismatch', available))
      // The path is real, so the routes at it are not dead.
      for (const route of pathMatches) usedRoutes.add(route)
      continue
    }

    for (const route of methodMatches) usedRoutes.add(route)
  }

  let suppressedDeadRoutes = 0

  if (config.reportDeadRoutes) {
    const eligible = new Set<HttpMethod>(config.deadRouteMethods)

    for (const route of routes) {
      if (usedRoutes.has(route)) continue
      if (!eligible.has(route.method)) continue
      if (config.ignoreRoutes.some(pattern => matchesGlob(route.pattern, pattern))) continue

      if (possiblyUsedRoutes.has(route)) {
        suppressedDeadRoutes++
        continue
      }

      findings.push(deadFinding(route))
    }
  }

  const totalCalls = internalCalls.length
  const percent = totalCalls === 0 ? 100 : Math.round((resolvedCalls / totalCalls) * 100)

  const ordered = sortFindings(findings)

  return {
    findings: ordered,
    coverage: { totalCalls, resolvedCalls, percent },
    stats: {
      routes: routes.length,
      callSites: totalCalls,
      externalCallSites: calls.length - totalCalls,
      errors: ordered.filter(finding => finding.severity === 'error').length,
      warnings: ordered.filter(finding => finding.severity === 'warn').length,
      infos: ordered.filter(finding => finding.severity === 'info').length,
      suppressedDeadRoutes,
      baselined: 0,
    },
  }
}

function brokenFinding(
  call: CallSite,
  reason: 'no-route' | 'method-mismatch',
  methodsAtPattern: HttpMethod[],
): Finding {
  const endpoint = `${call.method} ${call.pattern}`

  const message =
    reason === 'no-route'
      ? `calls ${endpoint} — no matching route found in backend`
      : `calls ${endpoint} — path exists but only accepts ${methodsAtPattern.join(', ')}`

  return {
    kind: 'broken',
    severity: 'error',
    message,
    file: call.file,
    line: call.line,
    column: call.column,
    fingerprint: fingerprintOf('broken', call.file, endpoint, reason),
    call,
    reason,
    methodsAtPattern,
  }
}

function deadFinding(route: Route): Finding {
  const endpoint = `${route.method} ${route.pattern}`

  return {
    kind: 'dead',
    severity: 'warn',
    message: `defines ${endpoint} — no call sites found`,
    file: route.file,
    line: route.line,
    column: 1,
    fingerprint: fingerprintOf('dead', route.file, endpoint),
    route,
  }
}

function unresolvedFinding(call: CallSite): Finding {
  return {
    kind: 'unresolved',
    severity: 'info',
    message: `could not resolve URL (${explain(call.reason)}) — ${call.raw}`,
    file: call.file,
    line: call.line,
    column: call.column,
    fingerprint: fingerprintOf('unresolved', call.file, call.raw),
    call,
  }
}

function explain(reason: CallSite['reason']): string {
  switch (reason) {
    case 'function-call':
      return 'URL is built by a function call'
    case 'non-constant-binding':
      return 'URL comes from a binding that is not a constant'
    case 'dynamic-base':
      return 'the base of the URL is computed at runtime'
    case 'relative-url':
      return 'URL is relative, so the base is unknown'
    case 'depth-limit':
      return 'gave up tracing constants'
    case 'unsupported-syntax':
      return 'unsupported syntax'
    default:
      return 'URL is a dynamic expression'
  }
}

/**
 * Identity of a finding, for the baseline file.
 *
 * Line numbers are excluded on purpose: a baseline that breaks every time
 * somebody adds an import above the finding is a baseline nobody keeps.
 */
export function fingerprintOf(...parts: string[]): string {
  return createHash('sha1').update(parts.join(' ')).digest('hex').slice(0, 12)
}

const SEVERITY_ORDER: Record<Finding['severity'], number> = { error: 0, warn: 1, info: 2 }

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    if (a.severity !== b.severity) return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    if (a.file !== b.file) return a.file.localeCompare(b.file)
    return a.line - b.line
  })
}
