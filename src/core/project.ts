import fs from 'node:fs'
import path from 'node:path'
import { Project, ts } from 'ts-morph'
import type { RoutedriftConfig } from './config.js'

/**
 * One ts-morph project per run, shared by the extractors and the scanner.
 *
 * Parsing a large repository twice is the difference between a tool people run
 * on every commit and one they run once and uninstall. It also matters for
 * correctness: constant tracing across imports needs the importing file and the
 * imported file in the same program.
 */
export function createProject(root: string, config: RoutedriftConfig): Project {
  const aliases = readPathAliases(root)

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    // Do not pull node_modules type declarations into the program. We only ever
    // ask about syntax and local declarations, so full type resolution is cost
    // without benefit.
    skipFileDependencyResolution: true,
    compilerOptions: {
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      noLib: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      baseUrl: aliases.baseUrl ?? root,
      paths: aliases.paths,
    },
  })

  project.addSourceFilesAtPaths(globsFor(root, config))
  return project
}

/**
 * Borrow the repository's own path aliases.
 *
 * Nearly every Next.js codebase imports through `@/lib/routes`. Without the alias
 * table those imports do not resolve, constant tracing dead-ends at the import
 * statement, and resolution coverage collapses on exactly the repositories the
 * tool is aimed at. Reading one file buys back most of that.
 */
function readPathAliases(root: string): { baseUrl?: string; paths?: ts.MapLike<string[]> } {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const file = path.join(root, name)
    if (!fs.existsSync(file)) continue

    try {
      // tsconfig files legally contain comments and trailing commas, so the
      // TypeScript parser is used rather than JSON.parse.
      const parsed = ts.parseConfigFileTextToJson(file, fs.readFileSync(file, 'utf8'))
      const options: unknown = (parsed.config as { compilerOptions?: unknown } | undefined)
        ?.compilerOptions

      if (typeof options !== 'object' || options === null) continue

      const { baseUrl, paths } = options as { baseUrl?: unknown; paths?: unknown }

      return {
        baseUrl: typeof baseUrl === 'string' ? path.resolve(root, baseUrl) : root,
        paths: isPathMap(paths) ? paths : undefined,
      }
    } catch {
      // A tsconfig we cannot read is not worth failing the run over.
    }
  }

  return {}
}

function isPathMap(value: unknown): value is ts.MapLike<string[]> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every(
      entry => Array.isArray(entry) && entry.every(item => typeof item === 'string'),
    )
  )
}

/**
 * Absolute include globs plus negated excludes, in the form ts-morph wants.
 */
export function globsFor(root: string, config: RoutedriftConfig): string[] {
  const base = toPosix(root).replace(/\/$/, '')
  const includes = config.include.map(pattern => `${base}/${stripLeadingSlash(pattern)}`)
  const excludes = config.exclude.map(pattern => `!${base}/${stripLeadingSlash(pattern)}`)
  return [...includes, ...excludes]
}

export function toPosix(value: string): string {
  return value.replace(/\\/g, '/')
}

function stripLeadingSlash(pattern: string): string {
  return pattern.replace(/^\.?\//, '')
}

/** Path relative to the analysed root, always with forward slashes. */
export function relativeTo(root: string, filePath: string): string {
  return toPosix(path.relative(root, filePath))
}
