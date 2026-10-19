/**
 * Unit tests for the keyboard-suggestion suppressor (src/lib/inputSuppress.ts).
 *
 * The module only needs a document with `addEventListener` plus
 * `querySelectorAll`, so the tests drive a tiny stand-in DOM instead of jsdom —
 * that keeps the check focused on the attribute bookkeeping (stamp / restore /
 * skip) rather than on DOM emulation.
 */
export {}
let failures = 0
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL ${name}`)
  }
}

/** Minimal element stand-in: attribute bag + the props `isTextField` inspects. */
class FakeElement {
  attrs: Record<string, string> = {}
  readOnly = false
  disabled = false
  type = 'text'
  isContentEditable = false
  constructor(public tagName: string) {}
  get nodeType(): number {
    return 1
  }
  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = String(value)
  }
  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null
  }
  removeAttribute(name: string): void {
    delete this.attrs[name]
  }
}

const fields: FakeElement[] = []
const listeners: Array<{ type: string; fn: (e: unknown) => void; capture: boolean }> = []
const documentStub = {
  addEventListener(type: string, fn: (e: unknown) => void, capture: boolean) {
    listeners.push({ type, fn, capture })
  },
  querySelectorAll() {
    return fields.slice()
  },
}
;(globalThis as unknown as { document: unknown }).document = documentStub

// Loaded AFTER the stub: the module reads `document` lazily inside its
// functions, so a static import would work too — a dynamic one keeps that
// ordering explicit. The specifier stays relative so esbuild resolves it
// against this source file, not the bundle it emits.
const { installInputSuppression, applyInputSuppression, suppressField } = await import(
  './inputSuppress'
)

/** The four attributes the module is expected to stamp. */
const SUPPRESS = ['autocomplete', 'autocorrect', 'autocapitalize', 'spellcheck'] as const
const hasAll = (el: FakeElement) =>
  SUPPRESS.every((k) => {
    const want = k === 'spellcheck' ? 'false' : 'off'
    return el.getAttribute(k) === want
  })
const hasNone = (el: FakeElement) => SUPPRESS.every((k) => !el.hasAttribute(k))
/** The module is typed against the real DOM; these stand-ins stand in for it. */
const asEl = (el: FakeElement) => el as unknown as Element

installInputSuppression()
check(
  'installs a capture-phase focusin listener',
  listeners.length === 1 && listeners[0].type === 'focusin' && listeners[0].capture === true,
)

// Disabled → nothing is touched, even on an explicit stamp request.
const offField = new FakeElement('TEXTAREA')
fields.push(offField)
applyInputSuppression(false)
check('disabled: the sweep leaves a textarea untouched', hasNone(offField))
suppressField(asEl(offField))
check('disabled: suppressField is a no-op', hasNone(offField))

// Enabled → the whole document is swept.
applyInputSuppression(true)
check('enabled: the sweep stamps every attribute', hasAll(offField))

// Fields that are not free text are skipped.
const checkbox = new FakeElement('INPUT')
checkbox.type = 'checkbox'
const password = new FakeElement('INPUT')
password.type = 'password'
const readOnlyArea = new FakeElement('TEXTAREA')
readOnlyArea.readOnly = true
const disabledInput = new FakeElement('INPUT')
disabledInput.disabled = true
fields.push(checkbox, password, readOnlyArea, disabledInput)
applyInputSuppression(true)
check('skips checkbox inputs', hasNone(checkbox))
check('skips password inputs', hasNone(password))
check('skips the readOnly clipboard sink', hasNone(readOnlyArea))
check('skips disabled inputs', hasNone(disabledInput))

// A field mounted later is caught by the focus listener.
const late = new FakeElement('TEXTAREA')
fields.push(late)
listeners[0].fn({ target: late })
check('the focus listener stamps fields mounted after install', hasAll(late))

// Fields created imperatively (xterm's hidden textarea) are stamped on demand.
const imperative = new FakeElement('TEXTAREA')
fields.push(imperative)
suppressField(asEl(imperative))
check('suppressField stamps an imperative field', hasAll(imperative))

// Turning the setting off restores the prior state exactly: attributes that
// were absent are removed again, and a pre-existing value is put back rather
// than left as "off".
const preStamped = new FakeElement('TEXTAREA')
preStamped.setAttribute('autocomplete', 'on')
fields.push(preStamped)
applyInputSuppression(true)
check('enabled: an existing value is overridden', preStamped.getAttribute('autocomplete') === 'off')
applyInputSuppression(false)
check('disabled: a pre-existing value comes back', preStamped.getAttribute('autocomplete') === 'on')
check(
  'disabled: the other three attributes are removed again',
  ['autocorrect', 'autocapitalize', 'spellcheck'].every((k) => !preStamped.hasAttribute(k)),
)
check('disabled: a field that was clean before stays clean', hasNone(offField))

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
