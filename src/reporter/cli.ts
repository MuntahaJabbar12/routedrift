import fs from 'node:fs'
import path from 'node:path'
import type { AnalysisResult, Finding, Severity } from '../types.js'
import { paletteFor, shouldColor, type Palette } from './color.js'

/**
 * Human-facing output.
 *
 * The report has one job: make a finding actionable in the three seconds a
 * developer will give it. That means the file and line first, the endpoint stated
 * plainly, and the offending source line shown rather than described — a code
 * frame removes the step where the reader has to go and find what the tool meant.
 */

export type TerminalOptions = {
  color?: boolean
  /** Suppress the info-level unresolved list, keeping the coverage number. */
  quiet?: boolean
  /** Lines of context on each side of the offending line. */
  context?: number
}

const LABELS: Record<Severity, string> = { error: 'ERROR', warn: 'WARN ', info: 'INFO ' }

export function reportToTerminal(result: AnalysisResult, options: TerminalOptions = {}): string {
  const palette = paletteFor(options.color ?? shouldColor())
  const context = options.context ?? 1

  const lines: string[] = []
  const shown = options.quiet
    ? result.findings.filter(finding => finding.severity !== 'info')
    : result.findings

  for (const finding of shown) {
    lines.push(...renderFinding(finding, result.root, palette, context))
    lines.push('')
  }

  lines.push(...renderSummary(result, palette))
  return lines.join('\n')
}

function renderFinding(
  finding: Finding,
  root: string,
  palette: Palette,
  context: number,
): string[] {
  const color = severityColor(finding.severity, palette)
  const location = `${finding.file}:${finding.line}:${finding.column}`

  const head = `${color(LABELS[finding.severity])} ${palette.underline(location)}`
  const body = `       ${detailFor(finding, palette)}`

  const frame = renderCodeFrame(root, finding, palette, context)

  return frame.length > 0 ? [head, body, '', ...frame] : [head, body]
}

/**
 * The finding restated as two facts: what the code does, and what is wrong with
 * it. Splitting them is what makes a dead-route warning read differently from a
 * broken call, without the reader having to parse a sentence.
 */
function detailFor(finding: Finding, palette: Palette): string {
  if (finding.kind === 'broken') {
    const endpoint = palette.bold(`${finding.call.method} ${finding.call.pattern}`)

    if (finding.reason === 'method-mismatch') {
      return `calls ${endpoint}\n       path exists, but the backend only accepts ${palette.bold(
        finding.methodsAtPattern.join(', '),
      )}`
    }

    return `calls ${endpoint}\n       no matching route found in backend`
  }

  if (finding.kind === 'dead') {
    const endpoint = palette.bold(`${finding.route.method} ${finding.route.pattern}`)
    return `defines ${endpoint}\n       no call sites found`
  }

  return `${palette.dim('unresolved URL')} ${finding.call.raw}\n       ${palette.dim(
    finding.message.replace(/^could not resolve URL \((.*?)\).*$/s, '$1'),
  )}`
}

function renderCodeFrame(
  root: string,
  finding: Finding,
  palette: Palette,
  context: number,
): string[] {
  const source = readLines(path.resolve(root, finding.file))
  if (!source) return []

  const target = finding.line
  const start = Math.max(1, target - context)
  const end = Math.min(source.length, target + context)
  const gutter = String(end).length

  const out: string[] = []

  for (let line = start; line <= end; line++) {
    const text = source[line - 1] ?? ''
    const number = String(line).padStart(gutter, ' ')

    if (line === target) {
      out.push(`  ${palette.red('>')} ${palette.dim(number + ' |')} ${text}`)
      const caretPad = ' '.repeat(Math.max(0, finding.column - 1))
      out.push(`    ${palette.dim(' '.repeat(gutter) + ' |')} ${caretPad}${palette.red('^')}`)
      continue
    }

    out.push(`    ${palette.dim(number + ' |')} ${text}`)
  }

  return out
}

const fileCache = new Map<string, string[] | null>()

function readLines(file: string): string[] | null {
  const cached = fileCache.get(file)
  if (cached !== undefined) return cached

  let lines: string[] | null = null
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  } catch {
    lines = null
  }

  fileCache.set(file, lines)
  return lines
}

function renderSummary(result: AnalysisResult, palette: Palette): string[] {
  const { coverage, stats } = result
  const lines: string[] = []

  const coverageText = `Resolved ${coverage.resolvedCalls} of ${coverage.totalCalls} call sites (${coverage.percent}%)`
  lines.push(coverage.percent >= 85 ? palette.green(coverageText) : palette.yellow(coverageText))

  lines.push(
    palette.dim(
      `Scanned ${stats.routes} route${stats.routes === 1 ? '' : 's'}` +
        (stats.externalCallSites > 0
          ? `, skipped ${stats.externalCallSites} call site${stats.externalCallSites === 1 ? '' : 's'} to other origins`
          : ''),
    ),
  )

  if (stats.suppressedDeadRoutes > 0) {
    lines.push(
      palette.dim(
        `${stats.suppressedDeadRoutes} possible dead route${stats.suppressedDeadRoutes === 1 ? '' : 's'} not reported: an unresolved call may reach them`,
      ),
    )
  }

  if (stats.baselined > 0) {
    lines.push(palette.dim(`${stats.baselined} finding(s) hidden by baseline`))
  }

  const counts = [
    stats.errors > 0 ? palette.red(`${stats.errors} error${stats.errors === 1 ? '' : 's'}`) : null,
    stats.warnings > 0
      ? palette.yellow(`${stats.warnings} warning${stats.warnings === 1 ? '' : 's'}`)
      : null,
    stats.infos > 0 ? palette.dim(`${stats.infos} unresolved`) : null,
  ].filter((entry): entry is string => entry !== null)

  lines.push(counts.length > 0 ? counts.join(', ') : palette.green('No drift found'))

  return lines
}

function severityColor(severity: Severity, palette: Palette) {
  if (severity === 'error') return palette.red
  if (severity === 'warn') return palette.yellow
  return palette.blue
}
