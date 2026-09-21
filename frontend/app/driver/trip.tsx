// Active trip: real GPS projected on the phone, demand ahead via SSE.
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, DriverSession, TransportRoute, WaitingForDriver } from "@/src/api";
import { getCorridor } from "@/src/corridors";
import { resumeTracking, stopTracking, subscribe, TrackerStatus } from "@/src/driver/tracker";
import { Zone } from "@/src/geo/corridor";
import { useSSE } from "@/src/realtime/sse";
import { store } from "@/src/storage";
import { makeStyles, spacing, radius, fontSize, useTheme } from "@/src/theme";

function zoneLabel(z: Zone | null, permission: TrackerStatus["permission"]): string {
  if (permission === "denied") return "إذن الموقع مرفوض - لا يمكن مشاركة تقدمك";
  if (!z) return "بانتظار إشارة GPS...";
  switch (z) {
    case "at_hub": return "في نقطة الانطلاق";
    case "at_terminus": return "وصلت نهاية الخط";
    case "on_corridor": return "على الخط";
    case "near_corridor": return "قرب الخط";
    case "off_corridor": return "خارج الخط - لا يتم الإرسال";
    case "wrong_direction": return "تتحرك بعكس الاتجاه المختار - لا يتم الإرسال";
  }
}

export default function DriverTrip() {
  const router = useRouter();
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ trip_id: string; route_id: string; direction: string }>();
  const direction = (Number(params.direction) === 1 ? 1 : 0) as 0 | 1;

  const [session, setSession] = useState<DriverSession | null>(null);
  const [route, setRoute] = useState<TransportRoute | null>(null);
  const [tracker, setTracker] = useState<TrackerStatus | null>(null);
  const [waiting, setWaiting] = useState<WaitingForDriver[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);

  const dir = route?.directions.find((d) => d.direction === direction);
  const totalKm = dir?.total_km ?? 0;
  const directionLabel = dir ? `${dir.origin_name_ar} ← ${dir.destination_name_ar}` : "";

  // Session, route, corridor, then start (or resume) tracking.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await store.getDriverSession();
      if (!s) {
        router.replace("/driver/login");
        return;
      }
      setSession(s);
      try {
        const [routes, { fc }] = await Promise.all([api.listRoutes(), getCorridor(params.route_id!)]);
        if (cancelled) return;
        setRoute(routes.find((r) => r.id === params.route_id) || null);
        await resumeTracking({ token: s.session_token, tripId: params.trip_id!, routeId: params.route_id!, direction, corridor: fc });
      } catch (e: any) {
        if (!cancelled) setErr(e.message || "تعذر بدء تتبع الموقع");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router, params.route_id, params.trip_id, direction]);

  useEffect(() => subscribe(setTracker), []);

  // Server dropped the trip/session (expired or logged out elsewhere): leave.
  useEffect(() => {
    if (tracker?.ended) {
      void stopTracking().then(() => router.replace("/driver/routes"));
    }
  }, [tracker?.ended, router]);

  useSSE<{ waiting: WaitingForDriver[] }>(session ? `/driver/trip/${params.trip_id}/stream` : null, {
    event: "demand",
    token: session?.session_token,
    onEvent: (d) => setWaiting(d.waiting),
    onEnded: () => {
      void stopTracking().then(() => router.replace("/driver/routes"));
    },
  });

  const endTrip = async () => {
    if (!session) return;
    setEnding(true);
    await stopTracking(); // stop the foreground service first, whatever the network does
    try {
      await api.endTrip(session.session_token, params.trip_id!);
    } catch {}
    router.replace("/driver/routes");
  };

  const progressKm = tracker?.progressKm ?? 0;
  const totalWaiting = waiting ? waiting.reduce((a, b) => a + b.count, 0) : 0;
  const progressPct = totalKm > 0 ? Math.min(100, (progressKm / totalKm) * 100) : 0;
  const sharing = tracker?.running && tracker.zone && !["off_corridor", "wrong_direction"].includes(tracker.zone);

  return (
    <View style={styles.container} testID="driver-trip-screen">
      <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <Text style={styles.headerLabel}>رحلة نشطة{route?.provisional ? " · مسار أولي" : ""}</Text>
        <Text style={styles.route}>{directionLabel || route?.name_ar || "..."}</Text>
        <View style={styles.progressWrap}>
          <View style={[styles.progressFill, { width: `${progressPct}%` }]} />
        </View>
        <Text style={styles.progressText}>
          {tracker?.progressKm == null ? "—" : progressKm.toFixed(1)} / {totalKm.toFixed(0)} كم
          {tracker?.speedKmh != null ? ` · ${tracker.speedKmh} كم/س` : ""}
        </Text>
      </View>

      <View style={styles.body}>
        <View style={[styles.statusRow, sharing ? styles.statusOk : styles.statusWarn]} testID="tracking-status">
          <Text style={styles.statusText}>{zoneLabel(tracker?.zone ?? null, tracker?.permission ?? "unknown")}</Text>
          <Text style={styles.statusSub}>
            {tracker?.running ? `الموقع يُحسب على الجهاز · ${tracker.uploads} تحديث` : "التتبع متوقف"}
          </Text>
        </View>

        {waiting === null ? (
          <ActivityIndicator color={colors.brandPrimary} />
        ) : (
          <>
            <View style={styles.metricCard} testID="waiting-count-card">
              <Text style={styles.metricLabel}>
                {totalWaiting > 0 ? `${totalWaiting} ${totalWaiting === 1 ? "راكب" : "ركاب"} بانتظارك` : "لا يوجد ركاب بانتظارك"}
              </Text>
            </View>
            {waiting.length > 0 ? (
              <View style={styles.list} testID="waiting-buckets-list">
                {waiting.map((w, i) => (
                  <View key={i} style={styles.bucketRow}>
                    <Text style={styles.bucketCount}>{w.count} {w.count === 1 ? "راكب" : "ركاب"}</Text>
                    <Text style={styles.bucketDistance}>
                      بعد {w.distance_km < 1 ? `${Math.round(w.distance_km * 1000)} م` : `${w.distance_km.toFixed(1)} كم`}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
          </>
        )}

        {err || tracker?.error ? <Text style={styles.err}>{err || tracker?.error}</Text> : null}
      </View>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
        <Pressable
          testID="end-trip-button"
          onPress={endTrip}
          disabled={ending}
          style={({ pressed }) => [styles.cta, (pressed || ending) && styles.pressed]}
        >
          <Text style={styles.ctaLabel}>{ending ? "..." : "خلصت"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.surface },
  header: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.divider, backgroundColor: colors.surfaceInverse },
  headerLabel: { color: colors.onSurfaceInverse, fontSize: fontSize.base, opacity: 0.7 },
  route: { color: colors.onSurfaceInverse, fontSize: 26, fontWeight: "500" },
  progressWrap: { height: 8, backgroundColor: "rgba(255,255,255,0.15)", borderRadius: radius.pill, marginTop: spacing.sm, overflow: "hidden" },
  progressFill: { height: "100%", backgroundColor: colors.brandTertiary, borderRadius: radius.pill },
  progressText: { color: colors.onSurfaceInverse, fontSize: fontSize.sm, opacity: 0.7 },
  body: { flex: 1, padding: spacing.lg, gap: spacing.lg },
  statusRow: { padding: spacing.md, borderRadius: radius.md, gap: 2 },
  statusOk: { backgroundColor: colors.surfaceSecondary },
  statusWarn: { backgroundColor: "#F3E3C3" },
  statusText: { color: colors.onSurface, fontSize: fontSize.lg, fontWeight: "500" },
  statusSub: { color: colors.muted, fontSize: fontSize.sm },
  metricCard: { backgroundColor: colors.brandTertiary, padding: spacing.xl, borderRadius: radius.lg, alignItems: "flex-start", gap: spacing.xs },
  metricLabel: { color: colors.onBrandTertiary, fontSize: 32, fontWeight: "500" },
  list: { gap: spacing.sm },
  bucketRow: { backgroundColor: colors.surfaceSecondary, padding: spacing.lg, borderRadius: radius.md, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  bucketCount: { color: colors.onSurface, fontSize: fontSize.xl, fontWeight: "500" },
  bucketDistance: { color: colors.brandPrimary, fontSize: fontSize.lg },
  err: { color: colors.error, fontSize: fontSize.base },
  footer: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, gap: spacing.md, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.divider },
  cta: { backgroundColor: colors.error, paddingVertical: spacing.lg + 2, borderRadius: radius.lg, alignItems: "center" },
  ctaLabel: { color: colors.onError, fontSize: fontSize.xl, fontWeight: "500" },
  pressed: { opacity: 0.7 },
}));
