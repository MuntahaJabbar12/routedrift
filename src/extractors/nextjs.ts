import path from 'node:path'
import { Project } from 'ts-morph'
import type { HttpMethod, Route } from '../types.js'

const METHODS = new Set<string>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

export function pathToPattern(relativePath: string): string {
  const parts = relativePath
    .replace(/\\/g, '/')
    .replace(/\/route\.(ts|js|tsx|jsx)$/, '')
    .split('/')
    .filter(Boolean)

  if (parts[0] === 'app') parts.shift()

  return '/' + parts
    .map(seg => seg.startsWith('[') && seg.endsWith(']')
      ? ':' + seg.slice(1, -1)
      : seg)
    .join('/')
}

export function extractNextRoutes(dir: string): Route[] {
  const root = path.resolve(dir)
  const project = new Project({ skipAddingFilesFromTsConfig: true })
  project.addSourceFilesAtPaths(`${root.replace(/\\/g, '/')}/app/**/route.{ts,js,tsx,jsx}`)

  const routes: Route[] = []

  for (const file of project.getSourceFiles()) {
    const relative = path.relative(root, file.getFilePath())
    const pattern = pathToPattern(relative)

    for (const [name, declarations] of file.getExportedDeclarations()) {
      if (!METHODS.has(name)) continue
      const declaration = declarations[0]
      if (!declaration) continue

      routes.push({
        method: name as HttpMethod,
        pattern,
        file: relative,
        line: declaration.getStartLineNumber(),
      })
    }
  }

  return routes
}