import path from 'node:path'
import { resolveUrl } from './resolver.js'
import { Project, SyntaxKind, Node } from 'ts-morph'
import type { CallSite, HttpMethod } from '../types.js'

const METHODS = new Set<string>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

function readMethod(call: Node): HttpMethod {
  const args = call.asKindOrThrow(SyntaxKind.CallExpression).getArguments()
  const options = args[1]
  if (!options || !Node.isObjectLiteralExpression(options)) return 'GET'

  const property = options.getProperty('method')
  if (!property || !Node.isPropertyAssignment(property)) return 'GET'

  const value = property.getInitializer()
  if (!value || !Node.isStringLiteral(value)) return 'GET'

  const literal = value.getLiteralValue().toUpperCase()
  return METHODS.has(literal) ? (literal as HttpMethod) : 'GET'
}

export function scanCallSites(dir: string): CallSite[] {
  const root = path.resolve(dir)
  const project = new Project({ skipAddingFilesFromTsConfig: true })
  project.addSourceFilesAtPaths(`${root.replace(/\\/g, '/')}/**/*.{ts,tsx,js,jsx}`)

  const sites: CallSite[] = []

  for (const file of project.getSourceFiles()) {
    const relative = path.relative(root, file.getFilePath())

    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (call.getExpression().getText() !== 'fetch') continue

      const first = call.getArguments()[0]
      if (!first) continue

            const pattern = resolveUrl(first)

      sites.push({
        method: readMethod(call),
        pattern,
        raw: call.getText(),
        file: relative,
        line: call.getStartLineNumber(),
      })
    }
  }

  return sites
}