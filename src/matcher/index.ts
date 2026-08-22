import type { CallSite, Finding, Route } from '../types.js'

function segments(pattern: string): string[] {
  return pattern.split('/').filter(Boolean)
}

export function patternsMatch(routePattern: string, callPattern: string): boolean {
  const route = segments(routePattern)
  const call = segments(callPattern)
  if (route.length !== call.length) return false

  return route.every((seg, i) => seg.startsWith(':') || seg === call[i])
}

export function match(routes: Route[], calls: CallSite[]): Finding[] {
  const findings: Finding[] = []
  const usedRoutes = new Set<Route>()

  for (const call of calls) {
    if (call.pattern === null) {
      findings.push({ kind: 'unresolved', call })
      continue
    }

    const hit = routes.find(
      r => r.method === call.method && patternsMatch(r.pattern, call.pattern!)
    )

    if (hit) usedRoutes.add(hit)
    else findings.push({ kind: 'broken', call })
  }

  for (const route of routes) {
    if (!usedRoutes.has(route)) findings.push({ kind: 'dead', route })
  }

  return findings
}