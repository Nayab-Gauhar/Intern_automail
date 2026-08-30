/**
 * Conflict-aware class merger.
 *
 * The design system spec (§8.4) reaches for `clsx` + `tailwind-merge`. Neither is
 * installed and the brief forbids adding dependencies without ratification, so this
 * is a small in-house equivalent: `clsx`-style flattening plus last-wins conflict
 * resolution over a curated table of the Tailwind utility groups this codebase
 * actually uses.
 *
 * Contract, identical to the spec's:
 *   cn('px-4 bg-surface', condition && 'bg-accent') -> 'px-4 bg-accent'
 * A later class in the same property group replaces an earlier one, so every
 * primitive can accept `className` and merge it last.
 *
 * Known limitation, stated rather than hidden: a utility whose prefix is not in the
 * table below falls back to exact-string dedupe. It is never dropped, but two
 * conflicting classes in an unlisted group will both survive and CSS source order
 * decides. Add the prefix to PREFIX_RULES when that bites. Swapping this file for
 * real `tailwind-merge` later is a drop-in change — the signature is the same.
 */

export type ClassValue =
  string | number | bigint | boolean | null | undefined | ClassValue[] | { [key: string]: unknown }

/* ------------------------------------------------------------------ flatten */

function flatten(value: ClassValue, out: string[]): void {
  if (!value) return
  if (typeof value === 'string') {
    if (value) out.push(value)
    return
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    out.push(String(value))
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) flatten(item, out)
    return
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (value[key]) out.push(key)
    }
  }
}

/* ------------------------------------------------- variant / base splitting */

/**
 * Split `hover:data-[state=open]:bg-accent` into its variant chain and base
 * utility. Bracket-depth aware, because both variants and values legitimately
 * contain colons (`[&:-webkit-autofill]:shadow-[inset_0_0_0_1px_var(--surface)]`).
 */
function splitVariants(token: string): { variants: string; base: string } {
  let depth = 0
  let lastColon = -1
  for (let i = 0; i < token.length; i += 1) {
    const ch = token[i]
    if (ch === '[' || ch === '(') depth += 1
    else if (ch === ']' || ch === ')') depth -= 1
    else if (ch === ':' && depth === 0) lastColon = i
  }
  if (lastColon === -1) return { variants: '', base: token }
  return { variants: token.slice(0, lastColon), base: token.slice(lastColon + 1) }
}

/* --------------------------------------------------------------- group table */

const BORDER_SIDE = /^(x|y|t|r|b|l|s|e)(-|$)/
const RADIUS_SIDE = /^(tl|tr|br|bl|ss|se|ee|es|t|r|b|l|s|e)(-|$)/
const BARE_LENGTH = /^(-?\d+(\.\d+)?(px|rem|em|%)?|px)$/
/** Inside brackets, a length starts with a digit/sign/dot or is a calc(); a var() or a
 *  colour function is not. `outline-[var(--ring-danger)]` is a colour, not a width. */
const BRACKET_LENGTH = /^\[(-?[\d.]|calc\()/

const FONT_WEIGHTS = new Set([
  'thin',
  'extralight',
  'light',
  'normal',
  'medium',
  'semibold',
  'bold',
  'extrabold',
  'black',
])

/** Our @theme font-size steps, plus Tailwind's defaults in case one slips in. */
const FONT_SIZES = new Set([
  'display-xl',
  'display-lg',
  'display-md',
  'heading',
  'subheading',
  'body',
  'body-sm',
  'label',
  'micro',
  'caption',
  'mono',
  'xs',
  'sm',
  'base',
  'lg',
  'xl',
  '2xl',
  '3xl',
  '4xl',
  '5xl',
])

const TEXT_ALIGN = new Set(['left', 'center', 'right', 'justify', 'start', 'end'])

const LINE_STYLES = new Set(['solid', 'dashed', 'dotted', 'double', 'none', 'hidden', 'wavy'])

function isLength(value: string): boolean {
  if (value.startsWith('[') || value.startsWith('(')) return BRACKET_LENGTH.test(value)
  return BARE_LENGTH.test(value)
}

/** Utilities whose whole name is the key. Checked before any prefix rule. */
const EXACT_RULES: Record<string, string> = {
  // display
  block: 'display',
  'inline-block': 'display',
  inline: 'display',
  flex: 'display',
  'inline-flex': 'display',
  grid: 'display',
  'inline-grid': 'display',
  table: 'display',
  contents: 'display',
  'flow-root': 'display',
  'list-item': 'display',
  hidden: 'display',
  // position
  static: 'position',
  fixed: 'position',
  absolute: 'position',
  relative: 'position',
  sticky: 'position',
  // flex
  'flex-row': 'flex-direction',
  'flex-row-reverse': 'flex-direction',
  'flex-col': 'flex-direction',
  'flex-col-reverse': 'flex-direction',
  'flex-wrap': 'flex-wrap',
  'flex-nowrap': 'flex-wrap',
  'flex-wrap-reverse': 'flex-wrap',
  // table
  'table-auto': 'table-layout',
  'table-fixed': 'table-layout',
  'border-collapse': 'border-collapse',
  'border-separate': 'border-collapse',
  // bare one-word utilities that are really the zero-suffix form
  border: 'border-w',
  rounded: 'rounded',
  shadow: 'shadow',
  outline: 'outline-style',
  ring: 'ring-w',
  resize: 'resize',
  truncate: 'text-overflow',
  'text-ellipsis': 'text-overflow',
  'text-clip': 'text-overflow',
  'text-nowrap': 'text-wrap',
  'text-wrap': 'text-wrap',
  'text-balance': 'text-wrap',
  'text-pretty': 'text-wrap',
  // typography switches
  uppercase: 'text-transform',
  lowercase: 'text-transform',
  capitalize: 'text-transform',
  'normal-case': 'text-transform',
  underline: 'text-decoration',
  overline: 'text-decoration',
  'line-through': 'text-decoration',
  'no-underline': 'text-decoration',
  italic: 'font-style',
  'not-italic': 'font-style',
  'tabular-nums': 'numeric',
  'proportional-nums': 'numeric',
  'lining-nums': 'numeric',
  'oldstyle-nums': 'numeric',
  'slashed-zero': 'numeric-zero',
  ordinal: 'numeric-figure',
  'normal-nums': 'numeric',
  // misc
  'sr-only': 'sr',
  'not-sr-only': 'sr',
  skeleton: 'skeleton',
  'gutter-x': 'gutter-x',
  grow: 'flex-grow',
  shrink: 'flex-shrink',
  'shadow-none': 'shadow',
}

type GroupResolver = (rest: string) => string

/**
 * Prefix -> group. Sorted longest-first at module load so `px-` beats `p-`.
 * A resolver function is used where one prefix spans several CSS properties
 * (`border-` is width *or* colour; `text-` is size, colour, or alignment).
 */
const PREFIX_RULES: Array<[string, string | GroupResolver]> = [
  // ---- box model
  ['px-', 'padding-x'],
  ['py-', 'padding-y'],
  ['pt-', 'padding-t'],
  ['pr-', 'padding-r'],
  ['pb-', 'padding-b'],
  ['pl-', 'padding-l'],
  ['ps-', 'padding-s'],
  ['pe-', 'padding-e'],
  ['p-', 'padding'],
  ['mx-', 'margin-x'],
  ['my-', 'margin-y'],
  ['mt-', 'margin-t'],
  ['mr-', 'margin-r'],
  ['mb-', 'margin-b'],
  ['ml-', 'margin-l'],
  ['ms-', 'margin-s'],
  ['me-', 'margin-e'],
  ['m-', 'margin'],
  ['scroll-m', 'scroll-margin'],
  ['space-x-', 'space-x'],
  ['space-y-', 'space-y'],
  ['gap-x-', 'gap-x'],
  ['gap-y-', 'gap-y'],
  ['gap-', 'gap'],
  ['min-w-', 'min-w'],
  ['max-w-', 'max-w'],
  ['min-h-', 'min-h'],
  ['max-h-', 'max-h'],
  ['w-', 'w'],
  ['h-', 'h'],
  ['size-', 'size'],
  ['aspect-', 'aspect'],
  ['object-', 'object'],
  // ---- position
  ['inset-x-', 'inset-x'],
  ['inset-y-', 'inset-y'],
  ['inset-', 'inset'],
  ['top-', 'top'],
  ['right-', 'right'],
  ['bottom-', 'bottom'],
  ['left-', 'left'],
  ['start-', 'start'],
  ['end-', 'end'],
  ['z-', 'z'],
  // ---- flex / grid
  ['basis-', 'flex-basis'],
  ['grow', 'flex-grow'],
  ['shrink', 'flex-shrink'],
  ['order-', 'order'],
  ['flex-', 'flex'],
  ['grid-cols-', 'grid-cols'],
  ['grid-rows-', 'grid-rows'],
  ['col-span-', 'col'],
  ['col-start-', 'col-start'],
  ['col-end-', 'col-end'],
  ['row-span-', 'row'],
  ['auto-cols-', 'auto-cols'],
  ['auto-rows-', 'auto-rows'],
  ['place-items-', 'place-items'],
  ['place-content-', 'place-content'],
  ['place-self-', 'place-self'],
  ['justify-items-', 'justify-items'],
  ['justify-self-', 'justify-self'],
  ['justify-', 'justify-content'],
  ['items-', 'align-items'],
  ['content-', 'align-content'],
  ['self-', 'align-self'],
  // ---- borders & radii
  [
    'border-',
    (rest) => {
      const side = BORDER_SIDE.exec(rest)
      if (side) return `border-w-${side[1]}`
      if (isLength(rest)) return 'border-w'
      if (LINE_STYLES.has(rest)) return 'border-style'
      if (rest.startsWith('spacing-')) return 'border-spacing'
      return 'border-color'
    },
  ],
  [
    'rounded-',
    (rest) => {
      const side = RADIUS_SIDE.exec(rest)
      return side ? `rounded-${side[1]}` : 'rounded'
    },
  ],
  ['divide-x-', 'divide-x'],
  ['divide-y-', 'divide-y'],
  ['divide-', 'divide-color'],
  // ---- colour & effects
  ['bg-clip-', 'bg-clip'],
  ['bg-origin-', 'bg-origin'],
  ['bg-size-', 'bg-size'],
  ['bg-position-', 'bg-position'],
  ['bg-', 'bg-color'],
  ['shadow-', 'shadow'],
  ['opacity-', 'opacity'],
  [
    'outline-',
    (rest) => {
      if (rest.startsWith('offset-')) return 'outline-offset'
      if (isLength(rest)) return 'outline-w'
      if (LINE_STYLES.has(rest)) return 'outline-style'
      return 'outline-color'
    },
  ],
  [
    'ring-',
    (rest) => {
      if (rest.startsWith('offset-')) return 'ring-offset'
      if (isLength(rest)) return 'ring-w'
      return 'ring-color'
    },
  ],
  [
    'decoration-',
    (rest) => {
      if (isLength(rest)) return 'decoration-thickness'
      if (LINE_STYLES.has(rest)) return 'decoration-style'
      return 'decoration-color'
    },
  ],
  ['underline-offset-', 'underline-offset'],
  ['stroke-', (rest) => (isLength(rest) ? 'stroke-w' : 'stroke-color')],
  ['fill-', 'fill'],
  // ---- typography
  [
    'text-',
    (rest) => {
      if (FONT_SIZES.has(rest)) return 'font-size'
      if (TEXT_ALIGN.has(rest)) return 'text-align'
      if (rest.startsWith('[') && /^\[[\d.]/.test(rest)) return 'font-size'
      return 'text-color'
    },
  ],
  ['font-', (rest) => (FONT_WEIGHTS.has(rest) ? 'font-weight' : 'font-family')],
  ['leading-', 'leading'],
  ['tracking-', 'tracking'],
  ['indent-', 'indent'],
  ['align-', 'vertical-align'],
  ['whitespace-', 'whitespace'],
  ['break-', 'break'],
  ['clamp-', 'clamp'],
  ['list-', 'list'],
  ['placeholder-', 'placeholder-color'],
  ['caret-', 'caret-color'],
  ['accent-', 'accent-color'],
  // ---- interaction & motion
  ['cursor-', 'cursor'],
  ['select-', 'select'],
  ['pointer-events-', 'pointer-events'],
  ['resize-', 'resize'],
  ['appearance-', 'appearance'],
  ['field-sizing-', 'field-sizing'],
  ['overflow-x-', 'overflow-x'],
  ['overflow-y-', 'overflow-y'],
  ['overflow-', 'overflow'],
  ['transition-', 'transition'],
  ['duration-', 'duration'],
  ['delay-', 'delay'],
  ['ease-', 'ease'],
  ['animate-', 'animate'],
  ['origin-', 'origin'],
  ['translate-x-', 'translate-x'],
  ['translate-y-', 'translate-y'],
  ['translate-', 'translate'],
  ['scale-', 'scale'],
  ['rotate-', 'rotate'],
  ['backdrop-blur', 'backdrop-blur'],
  ['blur', 'blur'],
]

const PREFIX_SORTED = [...PREFIX_RULES].sort((a, b) => b[0].length - a[0].length)

function baseGroup(raw: string): string {
  // A negative utility (`-mx-1`) belongs to the same group as its positive form.
  const cls = raw.startsWith('-') ? raw.slice(1) : raw
  const exact = EXACT_RULES[cls]
  if (exact !== undefined) return exact
  for (const [prefix, resolver] of PREFIX_SORTED) {
    if (cls.startsWith(prefix)) {
      const rest = cls.slice(prefix.length)
      return typeof resolver === 'string' ? resolver : resolver(rest)
    }
  }
  // Unknown utility: only conflicts with itself, so nothing is lost.
  return `lit:${cls}`
}

/** A class only conflicts with another carrying the same variant chain. */
function conflictKey(token: string): string {
  const { variants, base } = splitVariants(token)
  const important = base.startsWith('!') ? base.slice(1) : base
  return `${variants}|${baseGroup(important)}`
}

/* ------------------------------------------------------------------- public */

export function cn(...inputs: ClassValue[]): string {
  const raw: string[] = []
  flatten(inputs, raw)

  const tokens: string[] = []
  for (const chunk of raw) {
    for (const token of chunk.split(/\s+/)) {
      if (token) tokens.push(token)
    }
  }

  // Walk right-to-left so the last declaration of a group wins, then restore
  // source order for the survivors.
  const seen = new Set<string>()
  const kept: string[] = []
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i]
    if (token === undefined) continue
    const key = conflictKey(token)
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(token)
  }
  return kept.reverse().join(' ')
}
