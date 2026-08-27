import path from 'node:path'
import { Node, Project, SyntaxKind, type SourceFile } from 'ts-morph'
import { HTTP_METHODS, isHttpMethod, type HttpMethod, type Route } from '../types.js'
import { DEFAULT_CONFIG, type RoutedriftConfig } from '../core/config.js'
import { createProject, relativeTo, toPosix } from '../core/project.js'
import { normalizePattern } from '../core/normalize.js'

const METHOD_SET = new Set<string>(HTTP_METHODS)

/** Folders that shape the URL without appearing in it, or that are not routes at all. */
function isIgnoredSegment(segment: string): boolean {
  return (
    // Route groups: `app/(marketing)/api/...` -> `/api/...`
    (segment.startsWith('(') && segment.endsWith(')')) ||
    // Parallel routes: `app/@modal/...`
    segment.startsWith('@') ||
    // Private folders, excluded from routing by convention: `app/_lib/...`
    segment.startsWith('_')
  )
}

function segmentToPattern(segment: string): string | null {
  if (isIgnoredSegment(segment)) return null

  // Optional catch-all `[[...slug]]` and catch-all `[...slug]` both swallow the tail.
  if (/^\[\[\.\.\..+\]\]$/.test(segment)) return '*'
  if (/^\[\.\.\..+\]$/.test(segment)) return '*'
  if (/^\[.+\]$/.test(segment)) return ':' + segment.slice(1, -1)

  return segment
}

/**
 * Convert a Next.js route file path into a URL pattern.
 *
 * This is the whole reason the Next.js adapter came first: the routing table is
 * already sitting in the filesystem, so extraction is close to free.
 */
export function pathToPattern(relativePath: string): string {
  const withoutFile = toPosix(relativePath)
    .replace(/\/(route|page)\.(tsx?|jsx?|mts|cts|mjs|cjs)$/, '')
    // Pages Router: `pages/api/users/[id].ts` -> `pages/api/users/[id]`
    .replace(/\.(tsx?|jsx?|mts|cts|mjs|cjs)$/, '')

  const parts = withoutFile.split('/').filter(Boolean)

  // Strip an optional `src/` prefix, then the routing root itself.
  if (parts[0] === 'src') parts.shift()
  if (parts[0] === 'app' || parts[0] === 'pages') parts.shift()

  // `pages/api/users/index.ts` addresses the collection, not a child named `index`.
  if (parts[parts.length - 1] === 'index') parts.pop()

  const mapped = parts
    .map(segmentToPattern)
    .filter((segment): segment is string => segment !== null)

  return normalizePattern('/' + mapped.join('/'))
}

/** True for `app/**\/route.ts` — the App Router's HTTP handler file. */
function isAppRouteFile(relative: string): boolean {
  return /(^|\/)(app)\/.*\/route\.(tsx?|jsx?|mts|cts|mjs|cjs)$/.test(relative) ||
    /^(src\/)?app\/route\.(tsx?|jsx?|mts|cts|mjs|cjs)$/.test(relative)
}

/** True for `pages/api/**` — the Pages Router's API directory. */
function isPagesApiFile(relative: string): boolean {
  return /(^|\/)pages\/api\//.test(relative) && !/\.d\.ts$/.test(relative)
}

/**
 * App Router methods are export names, which makes them trivially readable:
 * `export async function DELETE()` means DELETE is supported and nothing else is.
 */
function appRouterMethods(file: SourceFile): Array<{ method: HttpMethod; line: number }> {
  const found: Array<{ method: HttpMethod; line: number }> = []

  for (const [name, declarations] of file.getExportedDeclarations()) {
    if (!METHOD_SET.has(name)) continue
    const declaration = declarations[0]
    if (!declaration) continue
    found.push({ method: name as HttpMethod, line: declaration.getStartLineNumber() })
  }

  return found
}

/**
 * Pages Router handlers are a single default export that branches on
 * `req.method`, so the supported verbs are not in the export names.
 *
 * We read the branches: every string compared against `.method` is treated as
 * supported. When a handler does not branch at all we assume it accepts
 * everything, because guessing narrowly here would invent broken-call errors for
 * code that is perfectly correct. Over-reporting dead routes is a warning;
 * over-reporting broken calls destroys trust in the tool.
 */
function pagesRouterMethods(file: SourceFile): HttpMethod[] {
  const found = new Set<HttpMethod>()

  for (const access of file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    if (access.getName() !== 'method') continue

    const parent = access.getParent()

    if (parent && Node.isBinaryExpression(parent)) {
      const other = parent.getLeft() === access ? parent.getRight() : parent.getLeft()
      collectMethodLiterals(other, found)
      continue
    }

    // `switch (req.method) { case 'POST': ... }`
    const switchStatement = access.getFirstAncestorByKind(SyntaxKind.SwitchStatement)
    if (switchStatement && switchStatement.getExpression().getText().includes('method')) {
      for (const clause of switchStatement.getClauses()) {
        if (Node.isCaseClause(clause)) collectMethodLiterals(clause.getExpression(), found)
      }
    }

    // `['POST', 'PUT'].includes(req.method)`
    const callParent = access.getFirstAncestorByKind(SyntaxKind.CallExpression)
    if (callParent) {
      const callee = callParent.getExpression()
      if (Node.isPropertyAccessExpression(callee) && callee.getName() === 'includes') {
        collectMethodLiterals(callee.getExpression(), found)
      }
    }
  }

  if (found.size === 0) return [...DEFAULT_CONFIG.deadRouteMethods]
  return [...found]
}

function collectMethodLiterals(node: Node, into: Set<HttpMethod>): void {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    const value = node.getLiteralValue().toUpperCase()
    if (isHttpMethod(value)) into.add(value)
    return
  }

  if (Node.isArrayLiteralExpression(node)) {
    for (const element of node.getElements()) collectMethodLiterals(element, into)
    return
  }

  if (Node.isIdentifier(node)) {
    for (const definition of node.getDefinitionNodes().slice(0, 2)) {
      if (Node.isVariableDeclaration(definition)) {
        const initializer = definition.getInitializer()
        if (initializer) collectMethodLiterals(initializer, into)
      }
    }
  }
}

export type NextExtractOptions = {
  /** Reuse an already-parsed project. The CLI always does; tests may not. */
  project?: Project
  config?: RoutedriftConfig
}

export function extractNextRoutes(dir: string, options: NextExtractOptions = {}): Route[] {
  const root = path.resolve(dir)
  const config = options.config ?? DEFAULT_CONFIG
  const project = options.project ?? createProject(root, config)

  const routes: Route[] = []
  const seen = new Set<string>()

  for (const file of project.getSourceFiles()) {
    const relative = relativeTo(root, file.getFilePath())
    if (relative.startsWith('..')) continue

    const isApp = isAppRouteFile(relative)
    const isPages = isPagesApiFile(relative)
    if (!isApp && !isPages) continue

    const pattern = pathToPattern(relative)

    const entries: Array<{ method: HttpMethod; line: number }> = isApp
      ? appRouterMethods(file)
      : pagesRouterMethods(file).map(method => ({ method, line: firstExportLine(file) }))

    for (const entry of entries) {
      const key = `${entry.method} ${pattern}`
      if (seen.has(key)) continue
      seen.add(key)

      routes.push({
        method: entry.method,
        pattern,
        file: relative,
        line: entry.line,
        framework: 'nextjs',
      })
    }
  }

  return routes.sort((a, b) =>
    a.pattern === b.pattern ? a.method.localeCompare(b.method) : a.pattern.localeCompare(b.pattern),
  )
}

function firstExportLine(file: SourceFile): number {
  const declarations = [...file.getExportedDeclarations().values()][0]
  return declarations?.[0]?.getStartLineNumber() ?? 1
}
