// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  SETTINGS_TAB_ID,
  TabsProvider,
  useTabs,
} from "./TabsContext";

function TabsHarness() {
  const { tabs, activeTabId, closeTab, openSettingsTab, setActiveTab, updateTab } =
    useTabs();

  const newTab = tabs.find((tab) => tab.mode === "new");

  return (
    <div>
      <button onClick={() => openSettingsTab("providers")}>Open Providers</button>
      <button onClick={() => openSettingsTab()}>Open Settings</button>
      <button
        onClick={() =>
          updateTab(SETTINGS_TAB_ID, { settingsSection: "updates" })
        }
      >
        Set Updates
      </button>
      <button
        onClick={() => {
          if (newTab) closeTab(newTab.id);
        }}
      >
        Close New
      </button>
      <button onClick={() => closeTab(SETTINGS_TAB_ID)}>Close Settings</button>
      <button
        onClick={() => {
          if (newTab) setActiveTab(newTab.id);
        }}
      >
        Activate New
      </button>
      <div data-testid="active-tab">{activeTabId}</div>
      <div data-testid="tabs-state">
        {tabs
          .map(
            (tab) =>
              `${tab.id}:${tab.mode}:${tab.settingsSection ?? "none"}`,
          )
          .join("|")}
      </div>
    </div>
  );
}

function renderTabsHarness() {
  return render(
    <TabsProvider>
      <TabsHarness />
    </TabsProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("TabsContext settings tab", () => {
  it("opens a singleton settings tab and remembers the current section", () => {
    renderTabsHarness();

    fireEvent.click(screen.getByRole("button", { name: "Open Providers" }));

    expect(screen.getByTestId("tabs-state").textContent).toContain(
      `${SETTINGS_TAB_ID}:settings:providers`,
    );
    expect(screen.getByTestId("active-tab").textContent).toBe(SETTINGS_TAB_ID);

    fireEvent.click(screen.getByRole("button", { name: "Set Updates" }));
    fireEvent.click(screen.getByRole("button", { name: "Activate New" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));

    const tabsState = screen.getByTestId("tabs-state").textContent ?? "";
    expect(tabsState).toContain(`${SETTINGS_TAB_ID}:settings:updates`);
    expect(tabsState.match(new RegExp(`${SETTINGS_TAB_ID}:settings`, "g"))).toHaveLength(
      1,
    );
    expect(screen.getByTestId("active-tab").textContent).toBe(SETTINGS_TAB_ID);
  });

  it("falls back to a fresh new tab when the last settings tab is closed", () => {
    renderTabsHarness();

    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Close New" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Settings" }));

    const tabsState = screen.getByTestId("tabs-state").textContent ?? "";
    expect(tabsState).not.toContain(`${SETTINGS_TAB_ID}:settings`);
    expect(tabsState).toContain(":new:none");
    expect(screen.getByTestId("active-tab").textContent).not.toBe(SETTINGS_TAB_ID);
  });
});
