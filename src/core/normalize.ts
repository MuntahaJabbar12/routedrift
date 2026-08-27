/**
 * Canonicalisation shared by both sides of the comparison.
 *
 * The matcher can only be simple if everything reaching it is already in one
 * form. All the fiddly cases — trailing slashes, query strings, duplicate
 * separators, Windows path separators — are dealt with exactly once, here.
 */

/** Origins that mean "this app", so the path after them is ours to check. */
const RELATIVE_PROTOCOL = /^\/\//
const ABSOLUTE_URL = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//

export type PatternKind =
  | { kind: 'internal'; pattern: string }
  | { kind: 'external' }
  /** Starts with something we could not resolve, so the base is unknown. */
  | { kind: 'dynamic-base' }
  | { kind: 'relative' }

/**
 * Decide what a resolved URL string actually is, and reduce it to a pattern.
 *
 * Being strict here is the main defence against false positives. A URL whose
 * first segment is dynamic (`` `${base}/users` ``) is *not* reported as broken —
 * we genuinely do not know what it points at, so it is classed as unresolvable.
 */
export function classifyUrl(raw: string, baseUrls: string[] = []): PatternKind {
  let url = raw.trim()

  // `//cdn.example.com/x` is protocol-relative, therefore another origin.
  if (RELATIVE_PROTOCOL.test(url)) return { kind: 'external' }

  const absolute = ABSOLUTE_URL.exec(url)
  if (absolute) {
    const afterProtocol = url.slice(absolute[0].length)
    const slash = afterProtocol.indexOf('/')
    const host = (slash === -1 ? afterProtocol : afterProtocol.slice(0, slash)).toLowerCase()
    const path = slash === -1 ? '/' : afterProtocol.slice(slash)

    // A dynamic host is not something we can attribute to this app.
    if (host.includes(':param') || host.includes('*')) return { kind: 'external' }

    const isOurs = baseUrls.some(base => hostOf(base) === host)
    if (!isOurs) return { kind: 'external' }
    url = path
  }

  url = stripQueryAndHash(url)

  if (url === '') return { kind: 'relative' }

  if (!url.startsWith('/')) {
    // `${process.env.API_URL}/api/users` resolves to `:API_URL/api/users`. The
    // path is visible but the base is not, which is a different problem from a
    // genuinely relative `users/5` and worth reporting as such.
    const head = url.split('/')[0] ?? ''
    return isDynamicSegment(head) || head.includes(':') ? { kind: 'dynamic-base' } : { kind: 'relative' }
  }

  const pattern = normalizePattern(url)
  const first = pattern.split('/').filter(Boolean)[0]

  // `/:param/users` — the first segment is interpolated, so the base is unknown.
  if (first !== undefined && isDynamicSegment(first)) return { kind: 'dynamic-base' }

  return { kind: 'internal', pattern }
}

function hostOf(base: string): string {
  const absolute = ABSOLUTE_URL.exec(base)
  const withoutProtocol = absolute ? base.slice(absolute[0].length) : base
  const slash = withoutProtocol.indexOf('/')
  return (slash === -1 ? withoutProtocol : withoutProtocol.slice(0, slash)).toLowerCase()
}

export function stripQueryAndHash(url: string): string {
  const cut = Math.min(
    ...[url.indexOf('?'), url.indexOf('#')].filter(i => i !== -1),
    url.length,
  )
  return url.slice(0, cut)
}

/**
 * Collapse a path to canonical form: one leading slash, no trailing slash,
 * no duplicate separators, no `./` noise.
 */
export function normalizePattern(pattern: string): string {
  const segments = pattern
    .replace(/\\/g, '/')
    .split('/')
    .filter(segment => segment !== '' && segment !== '.')

  if (segments.length === 0) return '/'
  return '/' + segments.join('/')
}

/** A segment that stands for "anything": `:id`, `*`, or Next.js `[id]`. */
export function isDynamicSegment(segment: string): boolean {
  return segment.startsWith(':') || segment === '*' || segment.startsWith('[')
}

/** A trailing `/*` (catch-all) swallows every remaining segment. */
export function hasCatchAll(pattern: string): boolean {
  return pattern.endsWith('/*') || pattern === '/*'
}

/** Turn a resolved expression into a readable parameter name: `${userId}` -> `:userId`. */
export function paramNameFor(expressionText: string): string {
  const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/.exec(expressionText.trim())
  if (identifier) return ':' + identifier[0]

  const trailing = /([A-Za-z_$][A-Za-z0-9_$]*)\s*$/.exec(expressionText.replace(/[)\]]+$/, ''))
  if (trailing?.[1]) return ':' + trailing[1]

  return ':param'
}

/** Longest prefix of a pattern made only of literal segments, e.g. `/api/v1`. */
export function staticPrefixOf(pattern: string): string | null {
  const segments = normalizePattern(pattern).split('/').filter(Boolean)
  const literal: string[] = []

  for (const segment of segments) {
    if (isDynamicSegment(segment)) break
    literal.push(segment)
  }

  if (literal.length === 0) return null
  return '/' + literal.join('/')
}
