import { Node, SyntaxKind, VariableDeclarationKind } from 'ts-morph'
import type { UnresolvedReason } from '../types.js'
import { paramNameFor } from '../core/normalize.js'

/**
 * URL resolution.
 *
 * The job is to turn the first argument of a `fetch` call back into the string it
 * will be at runtime — or to admit, precisely and without guessing, that it
 * cannot be known. The second half is as important as the first. A tool that
 * invents a pattern it is not sure about produces errors developers cannot act
 * on, and one bad error costs more trust than ten correct ones earn.
 *
 * So resolution is expressed as a list of fragments. Static text resolves to
 * itself; anything opaque becomes a named wildcard and is *recorded as* opaque.
 * A wildcard in the middle of a path is a perfectly good pattern
 * (`/api/users/:id`). A wildcard where the base should be is not, and the caller
 * treats that as unresolved rather than pretending.
 */

/** How far to chase constants before giving up. */
const MAX_DEPTH = 8
/** How many module boundaries a constant may be traced across. */
const MAX_IMPORT_HOPS = 1
/** Cap on candidate strings produced by ternaries, to keep the cross-product sane. */
const MAX_CANDIDATES = 8

type Fragment =
  | { kind: 'text'; values: string[] }
  | { kind: 'opaque'; placeholder: string; reason: UnresolvedReason }

export type Resolution = {
  /** Candidate URL strings. Empty when the expression is wholly opaque. */
  values: string[]
  /** Set when `values` is empty. */
  reason: UnresolvedReason | null
  /**
   * Best-effort pattern even for an unresolved URL, so the matcher can still
   * tell that *something* under `/api/admin/` is being called.
   */
  partial: string | null
}

type Context = {
  depth: number
  importHops: number
  /** Guards against `const a = b; const b = a;` and other cycles. */
  visited: Set<Node>
}

function newContext(): Context {
  return { depth: 0, importHops: 0, visited: new Set() }
}

function descend(context: Context, extraHop = 0): Context {
  return {
    depth: context.depth + 1,
    importHops: context.importHops + extraHop,
    visited: context.visited,
  }
}

/**
 * Resolve the URL argument of a call. This is the only entry point callers need.
 */
export function resolveUrl(node: Node): Resolution {
  const fragments = toFragments(node, newContext())
  return fromFragments(fragments)
}

/** Resolve an expression expected to be a short string, e.g. an HTTP method. */
export function resolveStringValue(node: Node): string | null {
  const resolution = resolveUrl(node)
  return resolution.values[0] ?? null
}

function fromFragments(fragments: Fragment[]): Resolution {
  const onlyFragment = fragments.length === 1 ? fragments[0] : undefined

  // A single opaque fragment means the whole URL is an unknown expression.
  if (onlyFragment?.kind === 'opaque') {
    return { values: [], reason: onlyFragment.reason, partial: null }
  }

  const candidates = crossProduct(fragments)
  if (candidates.length === 0) {
    return { values: [], reason: 'unsupported-syntax', partial: null }
  }

  return { values: candidates, reason: null, partial: candidates[0] ?? null }
}

function crossProduct(fragments: Fragment[]): string[] {
  let results: string[] = ['']

  for (const fragment of fragments) {
    const options = fragment.kind === 'text' ? fragment.values : [fragment.placeholder]
    if (options.length === 0) return []

    const next: string[] = []
    for (const prefix of results) {
      for (const option of options) {
        if (next.length >= MAX_CANDIDATES) break
        next.push(prefix + option)
      }
    }
    results = next
  }

  return [...new Set(results)]
}

function opaque(node: Node, reason: UnresolvedReason): Fragment {
  return { kind: 'opaque', placeholder: paramNameFor(node.getText()), reason }
}

function text(...values: string[]): Fragment {
  return { kind: 'text', values }
}

function toFragments(node: Node, context: Context): Fragment[] {
  if (context.depth > MAX_DEPTH) {
    return [{ kind: 'opaque', placeholder: ':param', reason: 'depth-limit' }]
  }
  if (context.visited.has(node)) {
    return [{ kind: 'opaque', placeholder: ':param', reason: 'depth-limit' }]
  }
  context.visited.add(node)

  // 1. A plain string. The easy and most common case.
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return [text(node.getLiteralValue())]
  }

  if (Node.isNumericLiteral(node)) {
    return [text(String(node.getLiteralValue()))]
  }

  // Unwrap syntax that does not change the value.
  if (
    Node.isParenthesizedExpression(node) ||
    Node.isAsExpression(node) ||
    Node.isSatisfiesExpression(node) ||
    Node.isNonNullExpression(node) ||
    Node.isTypeAssertion(node)
  ) {
    return toFragments(node.getExpression(), descend(context))
  }

  // 2. A template literal. Static parts pass through; each interpolation becomes
  //    a wildcard named after the expression, so the report reads `/api/users/:id`
  //    rather than `/api/users/:param`.
  if (Node.isTemplateExpression(node)) {
    const fragments: Fragment[] = [text(node.getHead().getLiteralText())]

    for (const span of node.getTemplateSpans()) {
      fragments.push(...toFragments(span.getExpression(), descend(context)))
      fragments.push(text(span.getLiteral().getLiteralText()))
    }

    return fragments
  }

  // String concatenation is the same problem as a template literal.
  if (Node.isBinaryExpression(node)) {
    const operator = node.getOperatorToken().getKind()

    if (operator === SyntaxKind.PlusToken) {
      return [
        ...toFragments(node.getLeft(), descend(context)),
        ...toFragments(node.getRight(), descend(context)),
      ]
    }

    // `base ?? '/api/fallback'` picks one side or the other, so both are candidates.
    if (
      operator === SyntaxKind.QuestionQuestionToken ||
      operator === SyntaxKind.BarBarToken
    ) {
      return alternatives(node.getLeft(), node.getRight(), node, context)
    }

    return [opaque(node, 'dynamic-expression')]
  }

  // A ternary yields two possible URLs. Both are kept as alternatives; the call
  // counts as valid if either matches a route. Collapsing them to one wildcard
  // would lose real information.
  if (Node.isConditionalExpression(node)) {
    return alternatives(node.getWhenTrue(), node.getWhenFalse(), node, context)
  }

  if (Node.isIdentifier(node)) {
    return traceIdentifier(node, context)
  }

  // 3. `ROUTES.users` where ROUTES is a const object, or an enum member.
  if (Node.isPropertyAccessExpression(node)) {
    return traceMember(node.getExpression(), node.getName(), node, context)
  }

  if (Node.isElementAccessExpression(node)) {
    const argument = node.getArgumentExpression()
    if (argument && (Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument))) {
      return traceMember(node.getExpression(), argument.getLiteralValue(), node, context)
    }
    return [opaque(node, 'dynamic-expression')]
  }

  // 4. Anything else: a helper call, a class member, a computed value. Reported
  //    as unresolved with the raw source text, never guessed at.
  if (Node.isCallExpression(node) || Node.isNewExpression(node) || Node.isAwaitExpression(node)) {
    return [opaque(node, 'function-call')]
  }

  return [opaque(node, 'dynamic-expression')]
}

/**
 * String value of an enum member.
 *
 * `getValue()` goes through the type checker, which is the right answer but is
 * not available when the program is loaded without lib files for speed. Reading
 * the initialiser syntactically covers the case that actually matters here — a
 * string-valued enum used as an endpoint constant.
 */
function enumMemberValue(member: Node): string | null {
  const enumMember = member.asKind(SyntaxKind.EnumMember)
  if (!enumMember) return null

  const initializer = enumMember.getInitializer()
  if (
    initializer &&
    (Node.isStringLiteral(initializer) || Node.isNoSubstitutionTemplateLiteral(initializer))
  ) {
    return initializer.getLiteralValue()
  }

  try {
    const value = enumMember.getValue()
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

/** Resolve two branches that could each supply the URL, keeping both as candidates. */
function alternatives(left: Node, right: Node, whole: Node, context: Context): Fragment[] {
  const a = fromFragments(toFragments(left, descend(context)))
  const b = fromFragments(toFragments(right, descend(context)))

  if (a.values.length > 0 && b.values.length > 0) {
    return [text(...a.values, ...b.values)]
  }

  // One branch is opaque, so the other cannot be asserted as the value.
  return [opaque(whole, 'dynamic-expression')]
}

function traceIdentifier(node: Node, context: Context): Fragment[] {
  const identifier = node.asKind(SyntaxKind.Identifier)
  if (!identifier) return [opaque(node, 'dynamic-expression')]

  for (const declaration of definitionsOf(identifier)) {
    const hop = crossesModule(identifier, declaration) ? 1 : 0
    if (context.importHops + hop > MAX_IMPORT_HOPS) {
      return [{ kind: 'opaque', placeholder: paramNameFor(identifier.getText()), reason: 'depth-limit' }]
    }

    const next = descend(context, hop)

    if (Node.isVariableDeclaration(declaration)) {
      // Only `const` is trustworthy. A `let` may be reassigned anywhere, and
      // substituting its initial value would be a guess dressed up as a fact.
      const statement = declaration.getFirstAncestorByKind(SyntaxKind.VariableStatement)
      if (statement && statement.getDeclarationKind() !== VariableDeclarationKind.Const) {
        return [{ kind: 'opaque', placeholder: paramNameFor(identifier.getText()), reason: 'non-constant-binding' }]
      }

      const initializer = declaration.getInitializer()
      if (initializer) return toFragments(initializer, next)
    }

    if (Node.isEnumMember(declaration)) {
      const value = enumMemberValue(declaration)
      if (value !== null) return [text(value)]
    }

    if (Node.isPropertyAssignment(declaration)) {
      const initializer = declaration.getInitializer()
      if (initializer) return toFragments(initializer, next)
    }

    // A function parameter is a runtime value by definition.
    if (Node.isParameterDeclaration(declaration) || Node.isBindingElement(declaration)) {
      return [{ kind: 'opaque', placeholder: paramNameFor(identifier.getText()), reason: 'dynamic-expression' }]
    }
  }

  return [{ kind: 'opaque', placeholder: paramNameFor(identifier.getText()), reason: 'non-constant-binding' }]
}

function traceMember(
  objectExpression: Node,
  propertyName: string,
  whole: Node,
  context: Context,
): Fragment[] {
  const objectDeclarations = Node.isIdentifier(objectExpression)
    ? definitionsOf(objectExpression.asKindOrThrow(SyntaxKind.Identifier))
    : []

  const literals: Node[] = []

  if (Node.isObjectLiteralExpression(objectExpression)) literals.push(objectExpression)

  for (const declaration of objectDeclarations) {
    if (Node.isVariableDeclaration(declaration)) {
      const initializer = declaration.getInitializer()
      if (initializer && Node.isObjectLiteralExpression(initializer)) literals.push(initializer)
      else if (initializer && Node.isAsExpression(initializer)) {
        const inner = initializer.getExpression()
        if (Node.isObjectLiteralExpression(inner)) literals.push(inner)
      }
    }

    if (Node.isEnumDeclaration(declaration)) {
      const member = declaration.getMember(propertyName)
      const value = member ? enumMemberValue(member) : null
      if (value !== null) return [text(value)]
    }
  }

  for (const literal of literals) {
    const objectLiteral = literal.asKindOrThrow(SyntaxKind.ObjectLiteralExpression)
    const property = objectLiteral.getProperty(propertyName)

    if (property && Node.isPropertyAssignment(property)) {
      const initializer = property.getInitializer()
      if (initializer) return toFragments(initializer, descend(context, 1))
    }
  }

  return [opaque(whole, 'dynamic-expression')]
}

/**
 * `getDefinitionNodes` already follows import specifiers to the real
 * declaration, which is what makes cross-module constant tracing cheap. The
 * results are cached because the language service is the slow part of a run.
 */
const definitionCache = new WeakMap<Node, Node[]>()

function definitionsOf(identifier: Node): Node[] {
  const cached = definitionCache.get(identifier)
  if (cached) return cached

  let definitions: Node[] = []
  try {
    definitions = identifier
      .asKindOrThrow(SyntaxKind.Identifier)
      .getDefinitionNodes()
      .slice(0, 4)
  } catch {
    definitions = []
  }

  definitionCache.set(identifier, definitions)
  return definitions
}

function crossesModule(from: Node, to: Node): boolean {
  return from.getSourceFile().getFilePath() !== to.getSourceFile().getFilePath()
}
