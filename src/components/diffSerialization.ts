/**
 * diffSerialization — opaque encoding for DiffFile data stored in Jotai atoms
 * and persisted sessions.
 *
 * Call sites use serializeDiff / deserializeDiff exclusively so the underlying
 * encoding (currently JSON) can be swapped (e.g. to compressed binary) in one place.
 */

import type { DiffFile } from "./DiffViewer";
export type { DiffFile };

/* ── Opaque type ─────────────────────────────────────────────────────────────
   SerializedDiff is a string at runtime but TypeScript treats it as a distinct
   type, preventing accidental use of raw strings where encoded diff data is
   expected.
─────────────────────────────────────────────────────────────────────────── */

declare const _brand: unique symbol;
export type SerializedDiff = string & { readonly [_brand]: "SerializedDiff" };

/* ── Encode ──────────────────────────────────────────────────────────────── */

/** Encode a single DiffFile into a SerializedDiff (e.g. ReviewEdit.diffFile). */
export function serializeDiff(data: DiffFile): SerializedDiff {
  return JSON.stringify(data) as SerializedDiff;
}

/* ── Decode ──────────────────────────────────────────────────────────────── */

/** Decode a SerializedDiff back to a DiffFile. */
export function deserializeDiff(s: SerializedDiff): DiffFile {
  return JSON.parse(s) as DiffFile;
}
