import path from 'node:path'
import { Node, Project, SyntaxKind, type CallExpression, type Expression, type SourceFile } from 'ts-morph'
import { isHttpMethod, type CallSite, type HttpMethod } from '../types.js'
import { DEFAULT_CONFIG, type RoutedriftConfig } from '../core/config.js'
import { createProject, relativeTo } from '../core/project.js'
import { classifyUrl, staticPrefixOf } from '../core/normalize.js'
import { resolveStringValue, resolveUrl } from './resolver.js'

/**
 * Finds the places in a repository that perform HTTP requests.
 *
 * Two things are extracted per call: the URL expression and the HTTP method. The
 * method matters as much as the path — renaming a folder and changing a verb are
 * the same class of silent breakage — and it is often *less* certain than the
 * path, so the scanner records how confident it is rather than assuming GET and
 * hoping.
 */

const AXIOS_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options'])
const FETCH_NAMES = new Set(['fetch', 'window.fetch', 'globalThis.fetch', 'self.fetch'])

type ClientCall = {
  client: 'fetch' | 'axios'
  /** Method taken from the callee itself, e.g. `axios.delete`. */
  methodFromCallee: HttpMethod | null
  /** Index of the argument holding the URL, or `null` when it is a config object. */
  urlArgumentIndex: number | null
  /** Index of the argument holding request options. */
  optionsArgumentIndex: number | null
}

export type ScanOptions = {
  project?: Project
  config?: RoutedriftConfig
}

export function scanCallSites(dir: string, options: ScanOptions = {}): CallSite[] {
  const root = path.resolve(dir)
  const config = options.config ?? DEFAULT_CONFIG
  const project = options.project ?? createProject(root, config)

  const sites: CallSite[] = []

  for (const file of project.getSourceFiles()) {
    const relative = relativeTo(root, file.getFilePath())
    if (relative.startsWith('..')) continue

    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const kind = identifyClient(call)
      if (!kind) continue

      const site = toCallSite(call, kind, relative, config)
      if (site) sites.push(site)
    }
  }

  return sites
}

/** Work out whether a call expression is an HTTP request, and of what shape. */
function identifyClient(call: CallExpression): ClientCall | null {
  const callee = call.getExpression()
  const text = callee.getText()

  if (FETCH_NAMES.has(text)) {
    return {
      client: 'fetch',
      methodFromCallee: null,
      urlArgumentIndex: 0,
      optionsArgumentIndex: 1,
    }
  }

  if (Node.isPropertyAccessExpression(callee)) {
    const verb = callee.getName()
    const receiver = callee.getExpression()

    if (verb === 'request' && isAxiosLike(receiver)) {
      return { client: 'axios', methodFromCallee: null, urlArgumentIndex: null, optionsArgumentIndex: 0 }
    }

    if (!AXIOS_VERBS.has(verb)) return null
    if (!isAxiosLike(receiver)) return null

    const method = verb.toUpperCase()
    if (!isHttpMethod(method)) return null

    // `axios.post(url, body, config)` — the config object is third.
    const optionsIndex = method === 'GET' || method === 'DELETE' || method === 'HEAD' || method === 'OPTIONS' ? 1 : 2

    return {
      client: 'axios',
      methodFromCallee: method,
      urlArgumentIndex: 0,
      optionsArgumentIndex: optionsIndex,
    }
  }

  // `axios(config)` or `axios(url, config)`, and the same for a created instance.
  if (isAxiosLike(callee)) {
    const first = call.getArguments()[0]
    const isConfigObject = first !== undefined && Node.isObjectLiteralExpression(first)

    return {
      client: 'axios',
      methodFromCallee: null,
      urlArgumentIndex: isConfigObject ? null : 0,
      optionsArgumentIndex: isConfigObject ? 0 : 1,
    }
  }

  return null
}

/**
 * True for `axios` itself and for instances produced by `axios.create(...)`.
 *
 * The instance case is worth the effort: a shared `api` client is the normal way
 * a real codebase calls its own backend, and a scanner that only understands the
 * bare `axios` import misses most of the call sites in exactly the repositories
 * it is meant to help.
 *
 * It is also the one place where naive implementation gets expensive. `.get` and
 * `.delete` are everywhere — `map.get`, `searchParams.get`, `set.delete` — and
 * asking the language service to resolve every one of them dominates the runtime
 * of a scan. So the expensive lookup is gated: it only runs when the file
 * actually imports axios, or when the receiver is named like an HTTP client.
 */
function isAxiosLike(node: Node): boolean {
  if (node.getText() === 'axios') return true
  if (!Node.isIdentifier(node)) return false

  const name = node.getText()
  if (!fileImportsAxios(node.getSourceFile()) && !looksLikeClientName(name)) return false

  for (const declaration of definitionsOf(node)) {
    if (!Node.isVariableDeclaration(declaration)) continue

    const initializer = declaration.getInitializer()
    if (!initializer) continue

    if (/^axios\s*\.\s*create\s*\(/.test(initializer.getText())) return true
  }

  return false
}

const CLIENT_NAME = /^(api|http|client|axios|instance|request|fetcher)$|(?:Api|Http|Client|Instance)$/

function looksLikeClientName(name: string): boolean {
  return CLIENT_NAME.test(name)
}

const importsAxiosCache = new WeakMap<SourceFile, boolean>()

function fileImportsAxios(file: SourceFile): boolean {
  const cached = importsAxiosCache.get(file)
  if (cached !== undefined) return cached

  const imports = file
    .getImportDeclarations()
    .some(declaration => declaration.getModuleSpecifierValue() === 'axios')

  importsAxiosCache.set(file, imports)
  return imports
}

const definitionCache = new WeakMap<Node, Node[]>()

function definitionsOf(node: Node): Node[] {
  const cached = definitionCache.get(node)
  if (cached) return cached

  let definitions: Node[] = []
  try {
    definitions = node.asKindOrThrow(SyntaxKind.Identifier).getDefinitionNodes().slice(0, 4)
  } catch {
    definitions = []
  }

  definitionCache.set(node, definitions)
  return definitions
}

function toCallSite(
  call: CallExpression,
  kind: ClientCall,
  file: string,
  config: RoutedriftConfig,
): CallSite | null {
  const args = call.getArguments()

  const urlNode: Node | undefined =
    kind.urlArgumentIndex === null
      ? readProperty(args[kind.optionsArgumentIndex ?? 0], 'url')
      : args[kind.urlArgumentIndex]

  if (!urlNode) return null

  const method = readMethod(kind, args)
  const resolution = resolveUrl(urlNode)
  const position = call.getSourceFile().getLineAndColumnAtPos(call.getStart())

  const base = {
    method: method.value,
    methodConfident: method.confident,
    raw: condense(call.getText()),
    client: kind.client,
    file,
    line: position.line,
    column: position.column,
  }

  if (resolution.values.length === 0) {
    return {
      ...base,
      pattern: null,
      alternatives: [],
      staticPrefix: null,
      reason: resolution.reason ?? 'dynamic-expression',
      external: false,
    }
  }

  const classified = resolution.values.map(value => classifyUrl(value, config.baseUrls))

  // A URL pointing at somebody else's API is not drift in this repository.
  if (classified.every(entry => entry.kind === 'external')) {
    return {
      ...base,
      pattern: null,
      alternatives: [],
      staticPrefix: null,
      reason: null,
      external: true,
    }
  }

  const internal = classified.flatMap(entry => (entry.kind === 'internal' ? [entry.pattern] : []))

  if (internal.length === 0) {
    // Resolved to *something*, but not to a checkable path — a dynamic base or a
    // relative URL. Reported as unresolved, which is an honest answer, instead of
    // being matched against routes it may have nothing to do with.
    const reason = classified.some(entry => entry.kind === 'dynamic-base')
      ? 'dynamic-base'
      : 'relative-url'

    return {
      ...base,
      pattern: null,
      alternatives: [],
      staticPrefix: partialPrefix(resolution.partial),
      reason,
      external: false,
    }
  }

  const [first, ...rest] = internal

  return {
    ...base,
    pattern: first ?? null,
    alternatives: rest,
    staticPrefix: staticPrefixOf(first ?? '/'),
    reason: null,
    external: false,
  }
}

/**
 * Longest literal prefix of an unresolved URL. Knowing that *something* under
 * `/api/admin/` is called is enough to stop us calling those routes dead.
 */
function partialPrefix(partial: string | null): string | null {
  if (!partial) return null

  const classified = classifyUrl(partial)
  if (classified.kind === 'internal') return staticPrefixOf(classified.pattern)

  const slash = partial.indexOf('/')
  if (slash === -1) return null

  const tail = partial.slice(slash)
  const tailClassified = classifyUrl(tail)
  return tailClassified.kind === 'internal' ? staticPrefixOf(tailClassified.pattern) : null
}

type MethodReading = { value: HttpMethod; confident: boolean }

function readMethod(kind: ClientCall, args: Node[]): MethodReading {
  if (kind.methodFromCallee) return { value: kind.methodFromCallee, confident: true }

  const optionsNode = kind.optionsArgumentIndex === null ? undefined : args[kind.optionsArgumentIndex]

  // `fetch(url)` with no init really is a GET. That is a fact, not a guess.
  if (!optionsNode) return { value: 'GET', confident: true }

  if (!Node.isObjectLiteralExpression(optionsNode)) {
    // Options came from a variable or a spread we cannot read, so the verb is
    // unknown. Matching will fall back to path-only.
    return { value: 'GET', confident: false }
  }

  const methodNode = readProperty(optionsNode, 'method')

  if (!methodNode) {
    // An object literal with no `method` is a GET — unless it spreads something
    // that might supply one.
    const spreads = optionsNode.getProperties().some(property => Node.isSpreadAssignment(property))
    return { value: 'GET', confident: !spreads }
  }

  const resolved = resolveStringValue(methodNode)
  if (!resolved) return { value: 'GET', confident: false }

  const upper = resolved.toUpperCase()
  if (!isHttpMethod(upper)) return { value: 'GET', confident: false }

  return { value: upper, confident: true }
}

/** Read a property initialiser out of an object literal, if it is written plainly. */
function readProperty(node: Node | undefined, name: string): Expression | undefined {
  if (!node || !Node.isObjectLiteralExpression(node)) return undefined

  const property = node.getProperty(name)
  if (!property) return undefined

  if (Node.isPropertyAssignment(property)) return property.getInitializer()
  if (Node.isShorthandPropertyAssignment(property)) return property.getNameNode()

  return undefined
}

/** Collapse a multi-line call to one line so it fits in a report. */
function condense(source: string): string {
  const single = source.replace(/\s+/g, ' ').trim()
  return single.length > 120 ? single.slice(0, 117) + '...' : single
}
