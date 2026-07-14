/**
 * Write-side hazard synchronization. This pure helper enforces a
 * union-with-dedup invariant on the parallel `hazards` (legacy text-only) and
 * `hazards_with_ranges` (structured) columns at the atlas_commit merge
 * boundary.
 *
 * # The bug this closes
 *
 * commit.ts uses INDEPENDENT per-column null-coalescing during merge:
 *
 *   const mergedHazards = hazards ?? existing?.hazards ?? [];
 *   const mergedHazardsWithRanges = hazards_with_ranges
 *     ?? existing?.hazards_with_ranges ?? [];
 *
 * Under sequential commits of different shape, this produces MIXED rows
 * where one column was PRESERVED from the prior commit and the other was
 * newly set:
 *
 *   1. Agent A commits hazards=['race in flush'] (no structured)
 *      → row { hazards: ['race in flush'], hazards_with_ranges: [] }
 *
 *   2. Agent B commits hazards_with_ranges=[{text: 'leak in cleanup',
 *      startLine: 42, endLine: 88}] (no legacy)
 *      → null-coalescing PRESERVES Agent A's legacy
 *      → row { hazards: ['race in flush'],
 *              hazards_with_ranges: [{text: 'leak in cleanup', ...}] }
 *
 * Readers that prefer structured entries could then suppress Agent A's
 * preserved text-only hazard. Synchronizing at the write boundary prevents
 * that mixed-row data loss.
 *
 * # Invariant
 *
 * After every atlas_commit, both columns contain the TEXT-EQUIVALENT UNION
 * of all hazards. The transformation:
 *
 *   1. Build text Set from legacy (trimmed, non-empty, string-only).
 *   2. Build text Set from structured (trimmed, non-empty, text-field only).
 *   3. Mirror orphan legacy (text in legacy Set but NOT in structured Set)
 *      to structured as `{text, startLine: null, endLine: null}` —
 *      file-level marker per AtlasHazardWithRange null-range convention.
 *   4. Mirror orphan structured (text in structured Set but NOT in legacy
 *      Set) to legacy as plain text.
 *   5. Identical texts collapse via Set membership (no double-mirror).
 *
 * # Why bidirectional (not just legacy → structured)
 *
 * The "deprecated legacy" framing might suggest unidirectional mirroring
 * (legacy → structured only, structured is the future). But bidirectional
 * has clean advantages:
 *
 *   - Both columns become COMPLETE text views; any tool that reads only
 *     one column gets full coverage.
 *   - The invariant is symmetric ("both columns = text union") which is
 *     easier to reason about than asymmetric ("structured is authoritative,
 *     legacy is best-effort projection").
 *   - Newly committed rows do not depend on the one-time FTS backfill used
 *     for historical databases.
 *   - Tooling that reads only the legacy column still gets every hazard text.
 *
 * # Trim semantics
 *
 * The text Sets use trimmed-for-comparison + filter-blank. Storage
 * preserves the original (untrimmed) text, matching reader behavior.
 * Whitespace-only differences in leading/trailing are
 * normalized for dedup; embedded whitespace differences (e.g., "foo\nbar"
 * vs "foo bar") are preserved as distinct (also matches readers).
 *
 * # Idempotency
 *
 * Running autoSyncHazardsColumns on its own output is a no-op (the second
 * pass finds no orphans because both Sets are already equal). This matches
 * the atlas_commit retry-safety contract — if a transient failure forces
 * the same commit through the merge twice, the second pass produces
 * identical row state.
 *
 * # Relationship to the explicit-clear case
 *
 * If an agent explicitly passes `hazards: []` to clear the legacy column
 * while leaving structured populated, auto-sync re-populates legacy from
 * structured. The agent's "clear" intent is interpreted at the union level:
 * the union of {} and {structured texts} = {structured texts}. To clear
 * BOTH, the agent must pass both `hazards: []` AND `hazards_with_ranges: []`.
 * This matches the union semantic readers already enforce.
 *
 * # Drift telemetry
 *
 * The invariant is enforced on every commit. The `driftStats` return field
 * lets the caller distinguish a useful heal from an already-aligned no-op
 * and emit a structured diagnostic only when drift was detected. The
 * counters are:
 *
 *   - legacyOrphansAdded: legacy entries (non-blank, trimmed-unique) that
 *     were NOT present in the structured column and got mirrored TO
 *     structured as file-level entries (null startLine/endLine). Non-zero
 *     means the caller's structured payload was missing texts that legacy
 *     had — a real drift heal direction.
 *
 *   - structuredOrphansAdded: structured entries (non-blank text) that
 *     were NOT present in the legacy column and got mirrored TO legacy
 *     as plain text. Non-zero means the caller's legacy payload was
 *     missing texts that structured had — the other drift heal direction.
 *
 *   - duplicatesCollapsed: count of unique texts that appeared in BOTH
 *     columns (Set intersection size). High value on a re-run indicates
 *     the invariant is already holding (idempotent re-pass produces
 *     duplicatesCollapsed = total-unique-texts, all orphans = 0). On a
 *     first pass with overlap, this is the count of texts the helper
 *     correctly recognized as already-shared and did NOT double-mirror.
 *
 * commit.ts emits a console.warn ONLY when `legacyOrphansAdded +
 * structuredOrphansAdded > 0` — silent on zero-drift commits to keep
 * log noise low; audible on drift heals so the rate can be observed.
 * The helper itself remains PURE: it computes the counters from the
 * existing intermediate values (orphanLegacyEntries/orphanStructuredEntries/
 * legacyTexts/structuredTexts) without any I/O. driftStats is data only —
 * the side-effecting log emission is the caller's responsibility.
 */

import type { AtlasHazardWithRange } from '../types.js';

/**
 * Counters describing how much drift autoSyncHazardsColumns healed on one
 * call. The caller uses them to decide whether to emit a diagnostic.
 *
 * Pure data — no methods, no side effects. See the module-level drift
 * telemetry section for the full semantics.
 */
export interface AutoSyncDriftStats {
  /**
   * Legacy entries (trimmed-unique, non-blank) that were NOT in the
   * structured column and got mirrored TO structured as file-level
   * entries (explicit null startLine/endLine).
   */
  legacyOrphansAdded: number;
  /**
   * Structured entries (non-blank text) that were NOT in the legacy
   * column and got mirrored TO legacy as plain text.
   */
  structuredOrphansAdded: number;
  /**
   * Set intersection size — unique texts that appeared in BOTH columns
   * (caller-shaped overlap; did not need mirroring). High value on a
   * re-pass of own output indicates idempotency is holding.
   */
  duplicatesCollapsed: number;
}

export interface AutoSyncHazardsResult {
  syncedHazards: string[];
  syncedHazardsWithRanges: AtlasHazardWithRange[];
  /**
   * Drift telemetry counters for the merge that just ran.
   * commit.ts emits a structured log when orphan counters > 0; silent
   * when zero. See AutoSyncDriftStats JSDoc for counter semantics.
   */
  driftStats: AutoSyncDriftStats;
}

/**
 * Enforce the union-with-dedup invariant on the parallel hazards columns.
 *
 * Pure function — no I/O, no side effects, deterministic output for given
 * inputs. Safe to call repeatedly (idempotent). Input arrays are NOT
 * mutated; new arrays are returned.
 *
 * @param legacy        Post-merge legacy hazards (text-only).
 * @param structured    Post-merge structured hazards (with optional line ranges).
 * @returns             Both columns extended to contain the text-equivalent
 *                      union. Original entries appear first; mirrored
 *                      orphans appended in their source-column order.
 */
export function autoSyncHazardsColumns(
  legacy: string[],
  structured: AtlasHazardWithRange[],
): AutoSyncHazardsResult {
  // Defensive: bad data (non-string legacy entries, non-object structured
  // entries, missing/blank `text` field) gets filtered out of the Sets but
  // preserved in the original-input copies below. This matches the reader
  // trim-and-filter pattern.
  const legacyTexts = new Set(
    legacy
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((trimmed) => trimmed.length > 0),
  );

  const structuredTexts = new Set(
    structured
      .map((entry) => (typeof entry?.text === 'string' ? entry.text.trim() : ''))
      .filter((trimmed) => trimmed.length > 0),
  );

  // Orphans: text appears in one Set but not the other. Iterate over the
  // SOURCE column (not the Set) so we preserve original casing/whitespace
  // and source order while using the Set only for membership testing.
  const orphanLegacyEntries = legacy.filter((entry) => {
    if (typeof entry !== 'string') return false;
    const trimmed = entry.trim();
    return trimmed.length > 0 && !structuredTexts.has(trimmed);
  });

  const orphanStructuredEntries = structured.filter((entry) => {
    const text = typeof entry?.text === 'string' ? entry.text.trim() : '';
    return text.length > 0 && !legacyTexts.has(text);
  });

  // Mirror orphan legacy → structured as file-level entries. Use explicit
  // `null` (not undefined / omitted) for startLine/endLine so the round-trip
  // shape matches the existing "file-level" convention pinned in the
  // structured-hazard round-trip contract.
  const syncedHazardsWithRanges: AtlasHazardWithRange[] = [
    ...structured,
    ...orphanLegacyEntries.map((text) => ({
      text,
      startLine: null,
      endLine: null,
    })),
  ];

  // Mirror orphan structured → legacy as plain text. Use the .text field
  // of the source structured entry (preserving original whitespace).
  const syncedHazards: string[] = [
    ...legacy,
    ...orphanStructuredEntries.map((entry) => entry.text),
  ];

  // Derive drift telemetry from the same intermediate
  // values already computed above; no extra passes over the input arrays.
  // duplicatesCollapsed = |legacyTexts ∩ structuredTexts| (unique texts
  // that appeared in BOTH columns and did NOT need mirroring). Counted
  // here rather than inferred from lengths because the orphan filters
  // preserve within-column duplicates (e.g. legacy=['foo','foo'] with
  // structured=[] produces 2 orphans even though only 1 unique text).
  let duplicatesCollapsed = 0;
  for (const text of legacyTexts) {
    if (structuredTexts.has(text)) duplicatesCollapsed += 1;
  }
  const driftStats: AutoSyncDriftStats = {
    legacyOrphansAdded: orphanLegacyEntries.length,
    structuredOrphansAdded: orphanStructuredEntries.length,
    duplicatesCollapsed,
  };

  return { syncedHazards, syncedHazardsWithRanges, driftStats };
}
