import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, TransportRoute, DriverSession } from "@/src/api";
import { getCorridor } from "@/src/corridors";
import { requestPermission, startTracking, stopTracking } from "@/src/driver/tracker";
import { store } from "@/src/storage";
import { makeStyles, spacing, radius, fontSize, useTheme } from "@/src/theme";

export default function DriverRoutes() {
  const router = useRouter();
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const [session, setSession] = useState<DriverSession | null>(null);
  const [routes, setRoutes] = useState<TransportRoute[]>([]);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [selectedDirection, setSelectedDirection] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const s = await store.getDriverSession();
      if (!s) {
        router.replace("/driver/login");
        return;
      }
      setSession(s);
      try {
        // Resume an active trip (state survives app restarts; it lives in Redis with a TTL).
        try {
          const t = await api.currentTrip(s.session_token);
          router.replace({
            pathname: "/driver/trip",
            params: { trip_id: t.trip_id, route_id: t.route_id, direction: String(t.direction) },
          });
          return;
        } catch (e: any) {
          if (e?.status === 401) {
            await store.clearDriverSession();
            router.replace("/driver/login");
            return;
          }
          // 404 = no active trip; anything else falls through to the route list
        }
        const r = await api.listRoutes();
        setRoutes(r.filter((x) => s.assigned_route_ids.includes(x.id)));
      } catch (e: any) {
        setErr(e.message || "خطأ في التحميل");
      } finally {
        setLoading(false);
      }
    })();
  }, [router]);

  const selectedRoute = routes.find((r) => r.id === selectedRouteId) || null;

  const startTrip = async () => {
    if (!session || !selectedRouteId || selectedDirection === null) return;
    setStarting(true);
    setErr(null);
    try {
      // Location permission first: no point starting a trip we cannot report.
      if (!(await requestPermission())) {
        setErr("يلزم إذن الموقع أثناء الاستخدام لبدء الرحلة. موقعك يُحسب على الجهاز ولا يُرسل.");
        return;
      }
      const { fc } = await getCorridor(selectedRouteId);
      const trip = await api.startTrip(session.session_token, selectedRouteId, selectedDirection);
      // Must be started while the app is in the foreground (Android foreground service).
      await startTracking({
        token: session.session_token, tripId: trip.trip_id, routeId: trip.route_id,
        direction: trip.direction === 1 ? 1 : 0, corridor: fc,
      });
      router.replace({
        pathname: "/driver/trip",
        params: {
          trip_id: trip.trip_id,
          route_id: trip.route_id,
          direction: String(trip.direction),
        },
      });
    } catch (e: any) {
      setErr(e.message || "خطأ");
    } finally {
      setStarting(false);
    }
  };

  const logout = async () => {
    await stopTracking();
    if (session) {
      try {
        await api.logout(session.session_token); // revoke server-side
      } catch {}
    }
    await store.clearDriverSession();
    router.replace("/");
  };

  if (loading) {
    return (
      <View style={[styles.container, styles.center]}>
        <ActivityIndicator color={colors.brandPrimary} />
      </View>
    );
  }

  return (
    <View style={styles.container} testID="driver-routes-screen">
      <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <View style={styles.headerRow}>
          <Pressable onPress={logout} testID="driver-logout" hitSlop={8}>
            <Text style={styles.logout}>خروج</Text>
          </Pressable>
          <Text style={styles.headerPhone}>{session?.phone}</Text>
        </View>
        <Text style={styles.title}>أي خط اليوم؟</Text>
        <Text style={styles.subtitle}>اختر الخط والاتجاه ثم ابدأ الرحلة</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + 140, gap: spacing.md }}
      >
        <Text style={styles.sectionTitle}>الخطوط المسموحة</Text>
        {routes.map((r) => (
          <Pressable
            key={r.id}
            testID={`route-option-${r.id}`}
            onPress={() => {
              setSelectedRouteId(r.id);
              setSelectedDirection(null);
            }}
            style={[styles.routeCard, selectedRouteId === r.id && styles.routeCardSelected]}
          >
            <Text style={[styles.routeName, selectedRouteId === r.id && styles.routeNameSelected]}>
              {r.name_ar}
            </Text>
            <Text style={styles.routeKm}>{r.directions[0]?.total_km.toFixed(0)} كم{r.provisional ? " · مسار أولي" : ""}</Text>
          </Pressable>
        ))}

        {selectedRoute ? (
          <View style={{ gap: spacing.sm, marginTop: spacing.lg }}>
            <Text style={styles.sectionTitle}>الاتجاه</Text>
            {selectedRoute.directions.map((d) => (
              <Pressable
                key={d.direction}
                testID={`direction-option-${d.direction}`}
                onPress={() => setSelectedDirection(d.direction)}
                style={[styles.dirCard, selectedDirection === d.direction && styles.dirCardSelected]}
              >
                <Text
                  style={[
                    styles.dirLabel,
                    selectedDirection === d.direction && styles.dirLabelSelected,
                  ]}
                >
                  {d.origin_name_ar} ← {d.destination_name_ar}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {err ? <Text style={styles.err}>{err}</Text> : null}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
        <Pressable
          testID="driver-start-trip"
          disabled={!selectedRouteId || selectedDirection === null || starting}
          onPress={startTrip}
          style={({ pressed }) => [
            styles.cta,
            (pressed || starting || !selectedRouteId || selectedDirection === null) && styles.pressed,
          ]}
        >
          <Text style={styles.ctaLabel}>{starting ? "..." : "ابدأ"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.surface },
  center: { alignItems: "center", justifyContent: "center" },
  header: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  headerPhone: { color: colors.muted, fontSize: fontSize.base },
  logout: { color: colors.error, fontSize: fontSize.base, paddingVertical: spacing.xs },
  title: { color: colors.onSurface, fontSize: 28, fontWeight: "500" },
  subtitle: { color: colors.muted, fontSize: fontSize.base },
  sectionTitle: { color: colors.muted, fontSize: fontSize.base },
  routeCard: {
    backgroundColor: colors.surfaceSecondary,
    padding: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: "transparent",
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  routeCardSelected: {
    borderColor: colors.brandPrimary,
    backgroundColor: colors.brandTertiary,
  },
  routeName: { color: colors.onSurfaceSecondary, fontSize: fontSize.xl, fontWeight: "500" },
  routeNameSelected: { color: colors.onBrandTertiary },
  routeKm: { color: colors.muted, fontSize: fontSize.base },
  dirCard: {
    backgroundColor: colors.surfaceSecondary,
    padding: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: "transparent",
  },
  dirCardSelected: {
    borderColor: colors.brandPrimary,
    backgroundColor: colors.brandTertiary,
  },
  dirLabel: { color: colors.onSurfaceSecondary, fontSize: fontSize.lg },
  dirLabelSelected: { color: colors.onBrandTertiary, fontWeight: "500" },
  err: { color: colors.error, fontSize: fontSize.base, marginTop: spacing.md },
  footer: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  cta: {
    backgroundColor: colors.brandPrimary,
    paddingVertical: spacing.lg + 2,
    borderRadius: radius.lg,
    alignItems: "center",
  },
  ctaLabel: { color: colors.onBrandPrimary, fontSize: fontSize.xl, fontWeight: "500" },
  pressed: { opacity: 0.6 },
}));
