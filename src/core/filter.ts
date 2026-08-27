import { HTTP_METHODS, type Finding } from '../types.js'
import { matchesGlob } from './glob.js'

/**
 * Finding suppression.
 *
 * Two escape hatches, because a static analyser without them is a static
 * analyser that gets deleted from CI the first time it is wrong. `ignore` is for
 * permanent exceptions expressed by hand; the baseline is for adopting the tool
 * on a repository that already has findings.
 */

const ENDPOINT_FORM = new RegExp(`^(\\*|${HTTP_METHODS.join('|')})\\s+/`, 'i')

/** The endpoint a finding is about, in `METHOD /path` form. */
export function endpointOf(finding: Finding): string {
  if (finding.kind === 'dead') return `${finding.route.method} ${finding.route.pattern}`
  if (finding.call.pattern) return `${finding.call.method} ${finding.call.pattern}`
  return `${finding.call.method} ${finding.call.staticPrefix ?? ''}`
}

/**
 * An ignore entry is either an endpoint (`GET /api/health`, `* /api/internal/**`)
 * or a file glob (`src/legacy/**`). Which one is inferred from the shape, so the
 * config stays terse.
 */
export function isIgnored(finding: Finding, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false

  const endpoint = endpointOf(finding)

  return patterns.some(pattern => {
    const trimmed = pattern.trim()
    if (trimmed === '') return false

    if (ENDPOINT_FORM.test(trimmed)) {
      const [rawMethod = '', ...rest] = trimmed.split(/\s+/)
      const routePart = rest.join(' ')
      const [endpointMethod = '', endpointPath = ''] = endpoint.split(/\s+/)

      const methodMatches =
        rawMethod === '*' || rawMethod.toUpperCase() === endpointMethod.toUpperCase()

      return methodMatches && matchesGlob(endpointPath, routePart)
    }

    return matchesGlob(finding.file, trimmed)
  })
}

export function applyIgnores(
  findings: Finding[],
  patterns: readonly string[],
): { kept: Finding[]; ignored: number } {
  if (patterns.length === 0) return { kept: findings, ignored: 0 }

  const kept = findings.filter(finding => !isIgnored(finding, patterns))
  return { kept, ignored: findings.length - kept.length }
}
