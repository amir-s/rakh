export interface RankedFuzzyItem<T> {
  item: T;
  index: number;
  score: number;
}

export function normalizeFuzzySearchValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[./:_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreSubsequence(field: string, token: string): number {
  let tokenIdx = 0;
  let firstMatch = -1;
  let gapCount = 0;

  for (let fieldIdx = 0; fieldIdx < field.length; fieldIdx += 1) {
    if (tokenIdx >= token.length) break;

    if (field[fieldIdx] === token[tokenIdx]) {
      if (firstMatch === -1) firstMatch = fieldIdx;
      tokenIdx += 1;
      continue;
    }

    if (tokenIdx > 0) {
      gapCount += 1;
    }
  }

  if (tokenIdx !== token.length || firstMatch === -1) {
    return 0;
  }

  const proximityBonus = Math.max(0, 20 - firstMatch);
  const gapPenalty = Math.min(28, gapCount);
  return Math.max(1, 42 + proximityBonus - gapPenalty);
}

function scoreTokenInField(field: string, token: string): number {
  if (!field || !token) return 0;

  if (field === token) return 220;
  if (field.startsWith(token)) return 170;

  const words = field.split(" ");
  if (words.some((word) => word.startsWith(token))) return 145;

  const containsIndex = field.indexOf(token);
  if (containsIndex >= 0) {
    return Math.max(90, 130 - containsIndex);
  }

  if (token.length < 2) return 0;
  return scoreSubsequence(field, token);
}

export function rankFuzzyItems<T>(
  items: T[],
  query: string,
  getFields: (item: T) => string[],
): RankedFuzzyItem<T>[] {
  const normalizedQuery = normalizeFuzzySearchValue(query);
  const baseEntries = items.map((item, index) => ({ item, index, score: 0 }));

  if (!normalizedQuery) {
    return baseEntries;
  }

  const tokens = normalizedQuery.split(" ").filter(Boolean);
  if (tokens.length === 0) {
    return baseEntries;
  }

  return items
    .map((item, index) => {
      const fields = getFields(item)
        .map(normalizeFuzzySearchValue)
        .filter(Boolean);
      let score = 0;

      for (const token of tokens) {
        let bestTokenScore = 0;
        for (const field of fields) {
          const tokenScore = scoreTokenInField(field, token);
          if (tokenScore > bestTokenScore) {
            bestTokenScore = tokenScore;
          }
        }

        if (bestTokenScore === 0) {
          return null;
        }

        score += bestTokenScore;
      }

      for (const field of fields) {
        if (field === normalizedQuery) {
          score += 140;
          continue;
        }
        if (field.startsWith(normalizedQuery)) {
          score += 90;
          continue;
        }
        if (field.includes(normalizedQuery)) {
          score += 55;
        }
      }

      return { item, index, score };
    })
    .filter((entry): entry is RankedFuzzyItem<T> => entry !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index);
}
