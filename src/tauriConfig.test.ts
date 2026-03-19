import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

type TauriConfig = {
  productName?: string;
  identifier?: string;
};

function readConfig(relativePath: string): TauriConfig {
  return JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  ) as TauriConfig;
}

describe("tauri config", () => {
  it("uses a distinct app identity for tauri dev", () => {
    const prodConfig = readConfig("../src-tauri/tauri.conf.json");
    const devConfig = readConfig("../src-tauri/tauri.dev.conf.json");

    expect(devConfig.identifier).toBeDefined();
    expect(devConfig.productName).toBeDefined();
    expect(devConfig.identifier).not.toBe(prodConfig.identifier);
    expect(devConfig.productName).not.toBe(prodConfig.productName);
  });
});
