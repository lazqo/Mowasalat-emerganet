// Force RTL for Arabic-first UI. This must run before any component mounts.
import { I18nManager } from "react-native";

if (!I18nManager.isRTL) {
  try {
    I18nManager.allowRTL(true);
    I18nManager.forceRTL(true);
  } catch {}
}
export {};
