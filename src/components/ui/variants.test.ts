import { describe, expect, it } from "vitest";
import {
  badgeVariantClass,
  buttonClasses,
  buttonSizeClass,
  buttonVariantClass,
  panelVariantClass,
  statusDotVariantClass,
} from "./variants";

describe("ui variants", () => {
  it("builds button variant and size classes", () => {
    expect(buttonVariantClass("primary")).toBe("ui-btn--primary");
    expect(buttonVariantClass("danger")).toBe("ui-btn--danger");
    expect(buttonSizeClass("xxs")).toBe("ui-btn--xxs");
    expect(buttonSizeClass("md")).toBe("ui-btn--md");
  });

  it("builds button class list with defaults", () => {
    expect(buttonClasses()).toContain("ui-btn");
    expect(buttonClasses()).toContain("ui-btn--primary");
    expect(buttonClasses()).toContain("ui-btn--sm");
  });

  it("builds button class list with overrides", () => {
    const className = buttonClasses({
      variant: "ghost",
      size: "xxs",
      fullWidth: true,
      className: "custom",
    });
    expect(className).toContain("ui-btn--ghost");
    expect(className).toContain("ui-btn--xxs");
    expect(className).toContain("ui-btn--full");
    expect(className).toContain("custom");
  });

  it("maps badge/status/panel helper variants", () => {
    expect(badgeVariantClass("success")).toBe("ui-badge--success");
    expect(statusDotVariantClass("thinking")).toBe("ui-status-dot--thinking");
    expect(panelVariantClass("default")).toBe("");
    expect(panelVariantClass("elevated")).toBe("ui-panel--elevated");
  });
});
