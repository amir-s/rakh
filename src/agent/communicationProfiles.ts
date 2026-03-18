import type { CommunicationProfileRecord } from "./db";

export function normalizeCommunicationProfileId(
  profileId?: string | null,
): string | undefined {
  if (!profileId) return undefined;
  const normalized = profileId.trim();
  if (normalized.length === 0) {
    return undefined;
  }
  return normalized;
}

export function resolveCommunicationProfileId(
  profileId: string | undefined | null,
  profiles: CommunicationProfileRecord[],
  defaultProfileId?: string | null,
): string | undefined {
  const normalizedProfileId = normalizeCommunicationProfileId(profileId);
  if (
    normalizedProfileId &&
    (profiles.length === 0 ||
      profiles.some((profile) => profile.id === normalizedProfileId))
  ) {
    return normalizedProfileId;
  }

  const normalizedDefaultProfileId =
    normalizeCommunicationProfileId(defaultProfileId);
  if (
    normalizedDefaultProfileId &&
    (profiles.length === 0 ||
      profiles.some((profile) => profile.id === normalizedDefaultProfileId))
  ) {
    return normalizedDefaultProfileId;
  }

  return profiles[0]?.id;
}

export function getCommunicationProfileRecord(
  profileId: string | undefined | null,
  profiles: CommunicationProfileRecord[],
  defaultProfileId?: string | null,
): CommunicationProfileRecord | null {
  const resolvedProfileId = resolveCommunicationProfileId(
    profileId,
    profiles,
    defaultProfileId,
  );
  if (!resolvedProfileId) return null;
  return profiles.find((profile) => profile.id === resolvedProfileId) ?? null;
}
