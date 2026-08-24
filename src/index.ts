import { extractNextRoutes } from './extractors/nextjs.js'
import { scanCallSites } from './callsites/scanner.js'
import { match } from './matcher/index.js'
import type { MatchResult } from './matcher/index.js'

export async function analyze(dir: string): Promise<MatchResult> {
  const routes = extractNextRoutes(dir)
  const calls = scanCallSites(dir)
  return match(routes, calls)
}