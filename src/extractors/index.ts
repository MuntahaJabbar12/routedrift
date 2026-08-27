import type { Project } from 'ts-morph'
import type { Route } from '../types.js'
import type { RoutedriftConfig } from '../core/config.js'
import { extractNextRoutes } from './nextjs.js'

/**
 * The one boundary that matters in this codebase.
 *
 * An extractor is handed a parsed project and a root, and returns the routes the
 * backend defines. It is not told what the frontend does, it cannot see call
 * sites, and it has no way to influence matching. Everything downstream consumes
 * `Route[]` and nothing else.
 *
 * Adding Express, Fastify, Hono or SvelteKit later is one file implementing this
 * interface plus one line in the registry below. Nothing in the resolver,
 * matcher or reporters changes. That property is the reason the interface is this
 * narrow, and it is worth being stubborn about: any time an extractor wants to
 * know something about call sites, the design has gone wrong.
 */
export type Extractor = {
  /** Stable identifier, used by `config.frameworks` and echoed in JSON output. */
  name: string
  /** Human label for error messages. */
  label: string
  /**
   * Cheap check for whether this framework is present, so that enabling every
   * extractor by default stays affordable.
   */
  detect(root: string, project: Project): boolean
  extract(context: ExtractorContext): Route[]
}

export type ExtractorContext = {
  root: string
  project: Project
  config: RoutedriftConfig
}

/**
 * Registered extractors.
 *
 * Express is deliberately absent in v1. Its routes are registered by function
 * calls and mounted under prefixes via `app.use('/api', router)`, which means an
 * honest implementation has to build a mount tree and resolve each route through
 * it — a materially harder problem than reading file paths. The project plan
 * named it the first thing to cut, and cutting it kept the resolution engine and
 * the product surface finished instead of half-finished. The interface above is
 * what makes that a scheduling decision rather than an architectural one.
 */
export const EXTRACTORS: Extractor[] = [
  {
    name: 'nextjs',
    label: 'Next.js',
    detect: (root, project) =>
      project
        .getSourceFiles()
        .some(file => /\/(app|pages)\//.test(file.getFilePath().replace(/\\/g, '/'))),
    extract: ({ root, project, config }) => extractNextRoutes(root, { project, config }),
  },
]

export function extractorsFor(names: readonly string[]): Extractor[] {
  const known = new Map(EXTRACTORS.map(extractor => [extractor.name, extractor]))
  const unknown = names.filter(name => !known.has(name))

  if (unknown.length > 0) {
    throw new Error(
      `unknown framework(s): ${unknown.join(', ')}. Available: ${[...known.keys()].join(', ')}`,
    )
  }

  return names.map(name => known.get(name)!)
}

export { extractNextRoutes } from './nextjs.js'
