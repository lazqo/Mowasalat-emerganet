import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, DriverSession, TransportRoute, WaitingForDriver } from "@/src/api";
import { store } from "@/src/storage";
import { makeStyles, spacing, radius, fontSize, useTheme } from "@/src/theme";

const POLL_MS = 5000;

// Progress simulator: for MVP demo without real GPS, the driver advances the
// bus along the corridor with a button. Real device: swap this for
// expo-location that computes route-relative progress locally on the phone.
const ADVANCE_KM = 0.5;

export default function DriverTrip() {
  const router = useRouter();
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ trip_id: string; route_id: string; direction: string }>();

  const [session, setSession] = useState<DriverSession | null>(null);
  const [route, setRoute] = useState<TransportRoute | null>(null);
  const [progressKm, setProgressKm] = useState(0);
  const [waiting, setWaiting] = useState<WaitingForDriver[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  const timer = useRef<any>(null);

  const totalKm = route?.directions.find((d) => d.direction === Number(params.direction))?.total_km ?? 0;
  const directionLabel = (() => {
    if (!route) return "";
    const d = route.directions.find((x) => x.direction === Number(params.direction));
    return d ? `${d.origin_name_ar} ← ${d.destination_name_ar}` : "";
  })();

  useEffect(() => {
    (async () => {
      const s = await store.getDriverSession();
      if (!s) {
        router.replace("/driver/login");
        return;
      }
      setSession(s);
      try {
        const routes = await api.listRoutes();
        setRoute(routes.find((r) => r.id === params.route_id) || null);
      } catch (e: any) {
        setErr(e.message || "خطأ");
      }
    })();
  }, [router, params.route_id]);

  const poll = async () => {
    if (!session) return;
    try {
      const w = await api.tripWaiting(session.session_token, params.trip_id!);
      setWaiting(w);
      setErr(null);
    } catch (e: any) {
      setErr(e.message || "خطأ");
    }
  };
  useEffect(() => {
    if (!session) return;
    poll();
    timer.current = setInterval(poll, POLL_MS);
    return () => timer.current && clearInterval(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const advance = async () => {
    if (!session || !route) return;
    const next = Math.min(totalKm, progressKm + ADVANCE_KM);
    try {
      await api.updateProgress(session.session_token, params.trip_id!, next, 40);
      setProgressKm(next);
    } catch (e: any) {
      setErr(e.message || "خطأ");
    }
  };

  const endTrip = async () => {
    if (!session) return;
    setEnding(true);
    try {
      await api.endTrip(session.session_token, params.trip_id!);
      router.replace("/driver/routes");
    } catch (e: any) {
      setErr(e.message || "خطأ");
      setEnding(false);
    }
  };

  const totalWaiting = waiting ? waiting.reduce((a, b) => a + b.count, 0) : 0;
  const progressPct = totalKm > 0 ? Math.min(100, (progressKm / totalKm) * 100) : 0;

  return (
    <View style={styles.container} testID="driver-trip-screen">
      <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <Text style={styles.headerLabel}>رحلة نشطة</Text>
        <Text style={styles.route}>{directionLabel || route?.name_ar || "..."}</Text>
        <View style={styles.progressWrap}>
          <View style={[styles.progressFill, { width: `${progressPct}%` }]} />
        </View>
        <Text style={styles.progressText}>
          {progressKm.toFixed(1)} / {totalKm.toFixed(0)} كم
        </Text>
      </View>

      <View style={styles.body}>
        {waiting === null ? (
          <ActivityIndicator color={colors.brandPrimary} />
        ) : (
          <>
            <View style={styles.metricCard} testID="waiting-count-card">
              <Text style={styles.metricLabel}>
                {totalWaiting > 0 ? `${totalWaiting} ركاب بانتظارك` : "لا يوجد ركاب بانتظارك"}
              </Text>
              {totalWaiting > 0 ? (
                <Text style={styles.metricSub}>يتم التحديث كل ٥ ثواني</Text>
              ) : null}
            </View>

            {waiting.length > 0 ? (
              <View style={styles.list} testID="waiting-buckets-list">
                {waiting.map((w, i) => (
                  <View key={i} style={styles.bucketRow}>
                    <Text style={styles.bucketCount}>
                      {w.count} {w.count === 1 ? "راكب" : "ركاب"}
                    </Text>
                    <Text style={styles.bucketDistance}>
                      بعد {w.distance_km < 1 ? `${Math.round(w.distance_km * 1000)} م` : `${w.distance_km.toFixed(1)} كم`}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
          </>
        )}

        {err ? <Text style={styles.err}>{err}</Text> : null}
      </View>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
        <Pressable
          testID="advance-progress-button"
          onPress={advance}
          disabled={progressKm >= totalKm}
          style={({ pressed }) => [
            styles.secondaryCta,
            (pressed || progressKm >= totalKm) && styles.pressed,
          ]}
        >
          <Text style={styles.secondaryCtaLabel}>تقدم {ADVANCE_KM.toFixed(1)} كم (محاكاة)</Text>
        </Pressable>
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
  header: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    backgroundColor: colors.surfaceInverse,
  },
  headerLabel: { color: colors.onSurfaceInverse, fontSize: fontSize.base, opacity: 0.7 },
  route: { color: colors.onSurfaceInverse, fontSize: 26, fontWeight: "500" },
  progressWrap: {
    height: 8,
    backgroundColor: "rgba(255,255,255,0.15)",
    borderRadius: radius.pill,
    marginTop: spacing.sm,
    overflow: "hidden",
  },
  progressFill: { height: "100%", backgroundColor: colors.brandTertiary, borderRadius: radius.pill },
  progressText: { color: colors.onSurfaceInverse, fontSize: fontSize.sm, opacity: 0.7 },
  body: { flex: 1, padding: spacing.lg, gap: spacing.lg },
  metricCard: {
    backgroundColor: colors.brandTertiary,
    padding: spacing.xl,
    borderRadius: radius.lg,
    alignItems: "flex-start",
    gap: spacing.xs,
  },
  metricLabel: { color: colors.onBrandTertiary, fontSize: 32, fontWeight: "500" },
  metricSub: { color: colors.onBrandTertiary, fontSize: fontSize.sm, opacity: 0.7 },
  list: { gap: spacing.sm },
  bucketRow: {
    backgroundColor: colors.surfaceSecondary,
    padding: spacing.lg,
    borderRadius: radius.md,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  bucketCount: { color: colors.onSurface, fontSize: fontSize.xl, fontWeight: "500" },
  bucketDistance: { color: colors.brandPrimary, fontSize: fontSize.lg },
  err: { color: colors.error, fontSize: fontSize.base },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  cta: {
    backgroundColor: colors.error,
    paddingVertical: spacing.lg + 2,
    borderRadius: radius.lg,
    alignItems: "center",
  },
  ctaLabel: { color: colors.onError, fontSize: fontSize.xl, fontWeight: "500" },
  secondaryCta: {
    backgroundColor: colors.surfaceSecondary,
    paddingVertical: spacing.lg,
    borderRadius: radius.lg,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
  },
  secondaryCtaLabel: { color: colors.onSurface, fontSize: fontSize.lg, fontWeight: "500" },
  pressed: { opacity: 0.7 },
}));
