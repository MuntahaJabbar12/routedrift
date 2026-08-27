/**
 * Minimal ANSI colouring.
 *
 * Respects `NO_COLOR` and non-TTY output, because a report piped into a log file
 * or a pull request comment should not be full of escape codes.
 */

export type Colorize = (value: string) => string

const identity: Colorize = value => value

/** ESC written by code point, so this source file stays plain ASCII. */
const CSI = String.fromCharCode(27) + '['

function wrap(open: number, close = 39): Colorize {
  return value => CSI + open + 'm' + value + CSI + close + 'm'
}

export type Palette = {
  red: Colorize
  yellow: Colorize
  blue: Colorize
  green: Colorize
  dim: Colorize
  bold: Colorize
  underline: Colorize
}

const plain: Palette = {
  red: identity,
  yellow: identity,
  blue: identity,
  green: identity,
  dim: identity,
  bold: identity,
  underline: identity,
}

const colored: Palette = {
  red: wrap(31),
  yellow: wrap(33),
  blue: wrap(34),
  green: wrap(32),
  dim: wrap(2, 22),
  bold: wrap(1, 22),
  underline: wrap(4, 24),
}

export function shouldColor(stream: { isTTY?: boolean } = process.stdout): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') return true
  return stream.isTTY === true
}

export function paletteFor(enabled: boolean): Palette {
  return enabled ? colored : plain
}
