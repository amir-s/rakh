#!/usr/bin/env node

const MODELS_DEV_URL = "https://models.dev/api.json";

function writeStderr(message) {
  process.stderr.write(`${message}\n`);
}

function usage() {
  writeStderr(
    "Usage: npm run model-search [--provider <provider>|-p <provider>] [id]",
  );
}

function parseArgs(argv, env) {
  const tokens = argv.slice(2);
  const queryTokens = [];
  let provider = null;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];

    if (token === "--provider" || token === "-p") {
      provider = tokens[i + 1] ?? null;
      i += 1;
      continue;
    }

    if (token.startsWith("--provider=")) {
      provider = token.slice("--provider=".length);
      continue;
    }

    if (token.startsWith("-p=")) {
      provider = token.slice("-p=".length);
      continue;
    }

    queryTokens.push(token);
  }

  const npmProvider = typeof env.npm_config_provider === "string"
    ? env.npm_config_provider.trim()
    : "";
  const npmShortProvider = typeof env.npm_config_p === "string"
    ? env.npm_config_p.trim()
    : "";

  if (!provider) {
    if (npmProvider && npmProvider !== "true") {
      provider = npmProvider;
    } else if (npmShortProvider && npmShortProvider !== "true") {
      provider = npmShortProvider;
    } else if (
      (npmProvider === "true" || npmShortProvider === "true") &&
      queryTokens.length >= 2
    ) {
      provider = queryTokens.shift() ?? null;
    }
  }

  return {
    provider: provider?.trim().toLowerCase() || null,
    query: queryTokens.join(" ").trim().toLowerCase(),
    queryTokens,
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function flattenModels(payload) {
  const matches = [];

  for (const [providerKey, providerValue] of Object.entries(payload)) {
    if (!isRecord(providerValue)) continue;
    const providerId =
      typeof providerValue.id === "string" ? providerValue.id : providerKey;
    const providerName =
      typeof providerValue.name === "string" ? providerValue.name : providerId;
    const models = isRecord(providerValue.models) ? providerValue.models : null;

    if (!models) continue;

    for (const modelValue of Object.values(models)) {
      if (!isRecord(modelValue) || typeof modelValue.id !== "string") continue;
      matches.push({
        provider: {
          id: providerId,
          name: providerName,
        },
        model: modelValue,
      });
    }
  }

  return matches;
}

async function main() {
  const parsedArgs = parseArgs(process.argv, process.env);
  const response = await fetch(MODELS_DEV_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${MODELS_DEV_URL}: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  if (!isRecord(payload)) {
    throw new Error("Unexpected response shape from models.dev");
  }

  const flattenedModels = flattenModels(payload);
  const providerAliases = new Map();
  for (const entry of flattenedModels) {
    providerAliases.set(entry.provider.id.toLowerCase(), entry.provider.id);
    providerAliases.set(entry.provider.name.toLowerCase(), entry.provider.id);
  }

  let provider = parsedArgs.provider;
  let effectiveQuery = parsedArgs.query;

  if (
    !provider &&
    parsedArgs.queryTokens.length >= 1 &&
    providerAliases.has(parsedArgs.queryTokens[0].toLowerCase())
  ) {
    provider = parsedArgs.queryTokens[0].toLowerCase();
    effectiveQuery = parsedArgs.queryTokens.slice(1).join(" ").trim().toLowerCase();
  }

  if (!provider && !effectiveQuery) {
    usage();
    process.exitCode = 1;
    return;
  }

  const providerId = provider ? providerAliases.get(provider) ?? provider : null;
  if (providerId && effectiveQuery.startsWith(`${providerId.toLowerCase()}/`)) {
    effectiveQuery = effectiveQuery.slice(providerId.length + 1);
  }

  const allModels = flattenedModels.filter((entry) => {
    if (!providerId) return true;
    return (
      entry.provider.id.toLowerCase() === providerId.toLowerCase() ||
      entry.provider.name.toLowerCase() === providerId.toLowerCase()
    );
  });

  if (!effectiveQuery) {
    process.stdout.write(`${JSON.stringify(allModels, null, 2)}\n`);
    return;
  }

  const exactMatches = allModels.filter(
    ({ model }) => model.id.toLowerCase() === effectiveQuery,
  );
  const matches =
    exactMatches.length > 0
      ? exactMatches
      : allModels.filter(({ model }) =>
          model.id.toLowerCase().includes(effectiveQuery),
        );

  process.stdout.write(`${JSON.stringify(matches, null, 2)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  writeStderr(message);
  process.exitCode = 1;
});
