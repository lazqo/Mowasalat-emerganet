// Persist driver session token across app restarts.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { DriverSession } from "./api";

const KEY_SESSION = "mow.driver.session";
const KEY_RECENT = "mow.passenger.recent";

export const store = {
  async saveDriverSession(s: DriverSession) {
    await AsyncStorage.setItem(KEY_SESSION, JSON.stringify(s));
  },
  async getDriverSession(): Promise<DriverSession | null> {
    const v = await AsyncStorage.getItem(KEY_SESSION);
    return v ? JSON.parse(v) : null;
  },
  async clearDriverSession() {
    await AsyncStorage.removeItem(KEY_SESSION);
  },
  async pushRecentDestination(id: string) {
    const raw = await AsyncStorage.getItem(KEY_RECENT);
    const list: string[] = raw ? JSON.parse(raw) : [];
    const next = [id, ...list.filter((x) => x !== id)].slice(0, 5);
    await AsyncStorage.setItem(KEY_RECENT, JSON.stringify(next));
  },
  async getRecentDestinations(): Promise<string[]> {
    const raw = await AsyncStorage.getItem(KEY_RECENT);
    return raw ? JSON.parse(raw) : [];
  },
};
