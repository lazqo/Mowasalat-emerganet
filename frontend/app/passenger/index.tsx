import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, Destination, TransportRoute } from "@/src/api";
import { store } from "@/src/storage";
import { makeStyles, spacing, radius, fontSize, useTheme } from "@/src/theme";

export default function PassengerHome() {
  const router = useRouter();
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const [query, setQuery] = useState("");
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [routes, setRoutes] = useState<TransportRoute[]>([]);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    setLoading(true);
    try {
      const [d, r, rec] = await Promise.all([
        api.listDestinations(),
        api.listRoutes(),
        store.getRecentDestinations(),
      ]);
      setDestinations(d);
      setRoutes(r);
      setRecentIds(rec);
    } catch (e: any) {
      setError(e.message || "خطأ في التحميل");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    const first = setTimeout(() => {
      void load();
    }, 0);
    return () => clearTimeout(first);
  }, []);

  // Passenger phone determines the "route + direction" that can serve the
  // chosen destination. For MVP we pick the first serving option and place
  // the passenger at "irbid" corridor start (progress 0) which is realistic
  // for the pilot corridor. This mirrors the "location determined on the
  // phone" privacy principle.
  const goToWaiting = async (dest: Destination) => {
    if (dest.id === "irbid") return; // can't wait for Irbid from Irbid
    // Find a route whose direction serves this destination (not origin=dest)
    let match: { route_id: string; direction: number } | null = null;
    for (const r of routes) {
      for (const d of r.directions) {
        const served = d.served.find((s) => s.stop_id === dest.id && s.progress_km > 0);
        if (served && d.origin_id === "irbid") {
          match = { route_id: r.id, direction: d.direction };
          break;
        }
      }
      if (match) break;
    }
    if (!match) return;
    await store.pushRecentDestination(dest.id);
    router.push({
      pathname: "/passenger/waiting",
      params: {
        destination_id: dest.id,
        destination_name: dest.name_ar,
        route_id: match.route_id,
        direction: String(match.direction),
      },
    });
  };

  const filtered = useMemo(() => {
    const q = query.trim();
    const list = destinations.filter((d) => d.id !== "irbid");
    if (!q) return list;
    return list.filter((d) => d.name_ar.includes(q) || d.name_en.toLowerCase().includes(q.toLowerCase()));
  }, [destinations, query]);

  const recentDests = useMemo(
    () => recentIds.map((id) => destinations.find((d) => d.id === id)).filter(Boolean) as Destination[],
    [recentIds, destinations],
  );

  return (
    <View style={styles.container} testID="passenger-home-screen">
      <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <Pressable
          onPress={() => router.back()}
          testID="passenger-back-button"
          style={styles.back}
          hitSlop={8}
        >
          <Text style={styles.backLabel}>رجوع</Text>
        </Pressable>
        <Text style={styles.title}>وين رايح؟</Text>
        <Text style={styles.subtitle}>اختر وجهتك لرؤية الباصات القادمة</Text>
        <View style={styles.searchWrap}>
          <TextInput
            testID="passenger-search-input"
            value={query}
            onChangeText={setQuery}
            placeholder="ابحث عن قرية أو بلدة"
            placeholderTextColor={colors.muted}
            style={styles.search}
            textAlign="right"
          />
        </View>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brandPrimary} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={load} style={styles.retry} testID="passenger-retry-button">
            <Text style={styles.retryLabel}>إعادة المحاولة</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          testID="passenger-destinations-list"
          data={filtered}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xl }}
          ListHeaderComponent={
            recentDests.length && !query ? (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>وجهات حديثة</Text>
                <View style={styles.chipRow}>
                  {recentDests.map((d) => (
                    <Pressable
                      key={d.id}
                      testID={`recent-chip-${d.id}`}
                      onPress={() => goToWaiting(d)}
                      style={styles.chip}
                    >
                      <Text style={styles.chipLabel}>{d.name_ar}</Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={styles.sectionTitle}>كل الوجهات</Text>
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <Pressable
              testID={`destination-row-${item.id}`}
              onPress={() => goToWaiting(item)}
              style={({ pressed }) => [styles.row, pressed && { opacity: 0.75 }]}
            >
              <Text style={styles.rowName}>{item.name_ar}</Text>
              <Text style={styles.rowSub}>{item.name_en}</Text>
            </Pressable>
          )}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.muted}>لا توجد نتائج</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.surface },
  header: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    gap: spacing.sm,
  },
  back: { alignSelf: "flex-start", paddingVertical: spacing.xs },
  backLabel: { color: colors.brandPrimary, fontSize: fontSize.base },
  title: { color: colors.onSurface, fontSize: 32, fontWeight: "500" },
  subtitle: { color: colors.muted, fontSize: fontSize.base },
  searchWrap: { marginTop: spacing.sm },
  search: {
    backgroundColor: colors.surfaceTertiary,
    color: colors.onSurface,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md + 2,
    fontSize: fontSize.lg,
  },
  section: { gap: spacing.md, marginBottom: spacing.md },
  sectionTitle: { color: colors.muted, fontSize: fontSize.base, marginTop: spacing.sm },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: {
    backgroundColor: colors.brandTertiary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.pill,
  },
  chipLabel: { color: colors.onBrandTertiary, fontSize: fontSize.base },
  row: {
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    alignItems: "flex-start",
    gap: 4,
  },
  rowName: { color: colors.onSurfaceSecondary, fontSize: fontSize.xl, fontWeight: "500" },
  rowSub: { color: colors.muted, fontSize: fontSize.sm },
  sep: { height: spacing.sm },
  center: { padding: spacing.xxl, alignItems: "center", gap: spacing.md },
  errorText: { color: colors.error, fontSize: fontSize.base },
  muted: { color: colors.muted, fontSize: fontSize.base },
  retry: {
    backgroundColor: colors.brandPrimary,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  retryLabel: { color: colors.onBrandPrimary, fontSize: fontSize.base, fontWeight: "500" },
}));
