/**
 * The shared vocabulary of the tool.
 *
 * Everything in `src/extractors/` produces `Route[]`. Everything in
 * `src/callsites/` produces `CallSite[]`. The matcher consumes both and knows
 * nothing about which framework or HTTP client produced them. That boundary is
 * the whole design: adding a framework means writing one extractor and changing
 * nothing else.
 */

export const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
] as const

export type HttpMethod = (typeof HTTP_METHODS)[number]

export function isHttpMethod(value: string): value is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value)
}

/** A route the backend actually defines. */
export type Route = {
  method: HttpMethod
  /** Canonical pattern, e.g. `/api/users/:id`. Catch-alls end in `/*`. */
  pattern: string
  /** Path relative to the analysed root, POSIX separators. */
  file: string
  line: number
  /** Which extractor produced this. Surfaced in JSON output for debugging. */
  framework: string
}

/**
 * Why a call site's URL could not be pinned down. Recorded so the report can
 * explain itself instead of just shrugging — "unresolved" with no reason is
 * indistinguishable from a bug in the resolver.
 */
export type UnresolvedReason =
  | 'dynamic-expression'
  | 'function-call'
  | 'non-constant-binding'
  | 'dynamic-base'
  | 'relative-url'
  | 'depth-limit'
  | 'unsupported-syntax'

/** A place in the source that performs an HTTP request. */
export type CallSite = {
  method: HttpMethod
  /**
   * `false` when the verb could not be read — options spread in from a variable,
   * a method name computed at runtime. Such calls are matched on path alone,
   * because asserting GET and reporting a method mismatch would be inventing a bug.
   */
  methodConfident: boolean
  /** Canonical pattern, or `null` when the URL could not be resolved. */
  pattern: string | null
  /**
   * Additional patterns this call site might produce, e.g. from a ternary.
   * The call is considered satisfied if *any* of them matches a route.
   */
  alternatives: string[]
  /**
   * Longest static prefix known even when the full URL is unresolved, e.g.
   * `/api/` for `` fetch(`/api/${resource}`) ``. Used to avoid reporting
   * routes under that prefix as dead.
   */
  staticPrefix: string | null
  reason: UnresolvedReason | null
  /** `true` when the URL points at another origin, so it is not ours to check. */
  external: boolean
  /** Original source text of the call, trimmed. Used in messages. */
  raw: string
  client: 'fetch' | 'axios'
  file: string
  line: number
  column: number
}

export type Severity = 'error' | 'warn' | 'info'

type FindingBase = {
  severity: Severity
  /** One-line human summary, already formatted. */
  message: string
  file: string
  line: number
  column: number
  /**
   * Stable identity for baselining. Deliberately excludes line numbers so that
   * unrelated edits above a finding do not invalidate the baseline.
   */
  fingerprint: string
}

export type Finding =
  | (FindingBase & {
      kind: 'broken'
      call: CallSite
      /** `no-route` if the path is unknown, `method-mismatch` if only the verb is wrong. */
      reason: 'no-route' | 'method-mismatch'
      /** Methods the backend does define at this path. Empty for `no-route`. */
      methodsAtPattern: HttpMethod[]
    })
  | (FindingBase & { kind: 'dead'; route: Route })
  | (FindingBase & { kind: 'unresolved'; call: CallSite })

export type Coverage = {
  /** Internal call sites considered. External origins are excluded. */
  totalCalls: number
  resolvedCalls: number
  /** Whole-number percentage, 100 when there is nothing to resolve. */
  percent: number
}

export type Stats = {
  routes: number
  callSites: number
  externalCallSites: number
  errors: number
  warnings: number
  infos: number
  /** Dead-route warnings withheld because an unresolved call may hit them. */
  suppressedDeadRoutes: number
  /** Findings hidden by the baseline file. */
  baselined: number
}

export type AnalysisResult = {
  root: string
  routes: Route[]
  calls: CallSite[]
  findings: Finding[]
  coverage: Coverage
  stats: Stats
}
