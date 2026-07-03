import { Temporal } from "temporal-polyfill";

// Time helpers built on Temporal. The CLI speaks ISO-8601 strings on the wire
// (and to disk), so these centralize the two conventions the codebase relies on:
// the current instant is always rendered at millisecond precision, and parsing a
// stored/received timestamp never throws.

// The current instant as an ISO-8601 string with millisecond precision — the
// wire format Frugl Cloud expects, and exactly what the legacy
// `new Date().toISOString()` produced. Pinning the precision matters: a bare
// `Temporal.Instant#toString()` emits micro/nanosecond digits when the clock
// carries them, which would drift from the millisecond timestamps the cloud
// stores and compares against.
export function nowIso(): string {
  return Temporal.Now.instant().toString({ smallestUnit: "millisecond" });
}

// The current instant. Prefer this over `new Date()` for "now" so callers stay
// on the Temporal type and can compare with `Temporal.Instant.compare`.
export function nowInstant(): Temporal.Instant {
  return Temporal.Now.instant();
}

// An ISO timestamp's epoch-millisecond value, or null when `iso` isn't parseable.
// Replaces the `Date.parse(iso)` / `new Date(iso).getTime()` NaN dance:
// `Temporal.Instant.from` throws on invalid input, so the try/catch lives here
// and callers get an explicit null to branch on.
export function epochMsFromIso(iso: string): number | null {
  try {
    return Temporal.Instant.from(iso).epochMilliseconds;
  } catch {
    return null;
  }
}
