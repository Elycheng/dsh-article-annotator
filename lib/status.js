/**
 * Small shared runtime status for diagnostics.
 *
 * The plugin installs itself through several optional services (web route,
 * agent tools, prompt section). On a new host build any of those can be
 * missing; the probe route reports exactly what came up so a user (or the
 * plugin page) can tell "installed but not loaded" apart from "loaded but
 * degraded" without reading host logs.
 */

export const status = {
  /** Whether the same-origin API route was registered. */
  routes: false,
  /** Whether the task/bundle patch was applied (always true once apply ran). */
  loaded: false,
  /** Tools that were successfully registered. */
  tools: [],
  /** Tools that could not be registered, with a reason. */
  toolsMissing: [],
  /** Whether the writing-style memory prompt section was registered. */
  styleSection: false,
  /** Human-readable degradations collected during apply. */
  warnings: [],
}

/** Record one non-fatal degradation. */
export function warn(message) {
  const text = String(message ?? '')
  if (text !== '' && !status.warnings.includes(text)) status.warnings.push(text)
}

/** Snapshot safe for JSON serialization. */
export function statusSnapshot() {
  return {
    loaded: status.loaded,
    routes: status.routes,
    tools: [...status.tools],
    toolsMissing: [...status.toolsMissing],
    styleSection: status.styleSection,
    warnings: [...status.warnings],
  }
}
