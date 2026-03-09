import { useMemo } from "react";
import { useTabs, SETTINGS_TAB_ID } from "@/contexts/TabsContext";
import {
  DEFAULT_SETTINGS_SECTION,
  type SettingsSectionId,
} from "./model";
import SettingsSurface from "./SettingsSurface";
import { useSettingsController } from "./useSettingsController";

export default function SettingsPage() {
  const { tabs, updateTab } = useTabs();
  const controller = useSettingsController();

  const activeSectionId = useMemo<SettingsSectionId>(() => {
    const settingsTab = tabs.find((tab) => tab.id === SETTINGS_TAB_ID);
    return settingsTab?.settingsSection ?? DEFAULT_SETTINGS_SECTION;
  }, [tabs]);

  return (
    <div className="settings-page-route">
      <SettingsSurface
        controller={controller}
        activeSectionId={activeSectionId}
        onChangeSection={(sectionId) =>
          updateTab(SETTINGS_TAB_ID, { settingsSection: sectionId })
        }
      />
    </div>
  );
}
