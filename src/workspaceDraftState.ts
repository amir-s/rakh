import { atom } from "jotai";
import type { AttachedImage, AttachedIssue } from "@/agent/types";

/**
 * Per-tab draft state atoms.
 *
 * These live in the global Jotai store so that the unsent prompt text,
 * attached images, and attached issues survive WorkspacePage unmounting
 * (e.g. when switching to the Settings tab and back).
 */

/** Unsent prompt text keyed by tab ID. */
export const draftInputByTabAtom = atom<Record<string, string>>({});

/** Attached images keyed by tab ID. */
export const draftImagesByTabAtom = atom<Record<string, AttachedImage[]>>(
  {},
);

/** Attached GitHub issues keyed by tab ID. */
export const draftIssuesByTabAtom = atom<Record<string, AttachedIssue[]>>({});
