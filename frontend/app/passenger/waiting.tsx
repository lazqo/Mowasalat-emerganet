import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, ApproachingBus, WaitOut } from "@/src/api";
import { makeStyles, spacing, radius, fontSize, useTheme } from "@/src/theme";

const POLL_MS = 5000;
// Passenger is assumed to be near Irbid start (progress 0km). Buses on this
// direction are heading away from Irbid, so on the outbound direction any
// active bus with progress <= passenger_progress + slack is "approaching".
const PASSENGER_PROGRESS_KM = 0.5;

function stateLabel(s: ApproachingBus["state"]): string {
  if (s === "very_near") return "الباص قريب جداً";
  if (s === "near") return "الباص قريب";
  return "الباص قادم";
}

export default function PassengerWaiting() {
  const router = useRouter();
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    destination_id: string;
    destination_name: string;
    route_id: string;
    direction: string;
  }>();

  const [buses, setBuses] = useState<ApproachingBus[] | null>(null);
  const [wait, setWait] = useState<WaitOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<any>(null);

  const direction = Number(params.direction ?? 0);

  const poll = async () => {
    try {
      if (wait) {
        const s = await api.waitStatus(wait.wait_id);
        setBuses(s.buses);
      } else {
        const list = await api.buses(
          params.destination_id!,
          PASSENGER_PROGRESS_KM,
          params.route_id!,
          direction,
        );
        setBuses(list);
      }
      setErr(null);
    } catch (e: any) {
      setErr(e.message || "خطأ");
    }
  };

  useEffect(() => {
    poll();
    timer.current = setInterval(poll, POLL_MS);
    return () => timer.current && clearInterval(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wait?.wait_id]);

  const onIAmWaiting = async () => {
    setBusy(true);
    try {
      const w = await api.createWait(
        params.destination_id!,
        params.route_id!,
        direction,
        PASSENGER_PROGRESS_KM,
      );
      setWait(w);
    } catch (e: any) {
      setErr(e.message || "خطأ");
    } finally {
      setBusy(false);
    }
  };

  const onBoard = async () => {
    if (!wait) return;
    setBusy(true);
    try {
      await api.waitBoard(wait.wait_id);
      router.back();
    } catch (e: any) {
      setErr(e.message || "خطأ");
    } finally {
      setBusy(false);
    }
  };

  const onCancel = async () => {
    if (!wait) {
      router.back();
      return;
    }
    setBusy(true);
    try {
      await api.waitCancel(wait.wait_id);
      router.back();
    } catch (e: any) {
      setErr(e.message || "خطأ");
    } finally {
      setBusy(false);
    }
  };

  const nearest = buses && buses.length ? buses[0] : null;

  return (
    <View style={styles.container} testID="passenger-waiting-screen">
      <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <Pressable onPress={onCancel} style={styles.back} hitSlop={8} testID="waiting-back-button">
          <Text style={styles.backLabel}>رجوع</Text>
        </Pressable>
        <Text style={styles.smallLabel}>مواصلات إلى</Text>
        <Text style={styles.destination}>{params.destination_name}</Text>
      </View>

      <View style={styles.body}>
        {buses === null ? (
          <ActivityIndicator color={colors.brandPrimary} />
        ) : nearest ? (
          <View style={styles.heroCard} testID="nearest-bus-card">
            <Text style={styles.heroLabel}>{stateLabel(nearest.state)}</Text>
            <Text style={styles.heroEta}>حوالي {nearest.eta_min} دقيقة</Text>
            <Text style={styles.heroDist}>على بعد {nearest.distance_km.toFixed(1)} كم</Text>
          </View>
        ) : (
          <View style={styles.heroCard} testID="no-bus-card">
            <Text style={styles.heroLabel}>لا يوجد باصات حالياً</Text>
            <Text style={styles.heroDist}>يتم التحديث كل ٥ ثواني</Text>
          </View>
        )}

        {buses && buses.length > 1 ? (
          <View style={styles.list} testID="other-buses-list">
            <Text style={styles.listTitle}>باصات أخرى</Text>
            {buses.slice(1).map((b) => (
              <View key={b.pseudonym} style={styles.otherRow}>
                <Text style={styles.otherEta}>حوالي {b.eta_min} دقيقة</Text>
                <Text style={styles.otherDist}>{b.distance_km.toFixed(1)} كم</Text>
              </View>
            ))}
          </View>
        ) : null}

        {wait ? (
          <View style={styles.confirmedCard} testID="waiting-confirmed-card">
            <Text style={styles.confirmedLabel}>أنت بانتظار مواصلات إلى {params.destination_name}</Text>
            <Text style={styles.confirmedHint}>سيختفي طلبك تلقائياً بعد ٢٠ دقيقة</Text>
          </View>
        ) : null}

        {err ? <Text style={styles.errorText}>{err}</Text> : null}
      </View>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
        {!wait ? (
          <Pressable
            testID="im-waiting-button"
            disabled={busy}
            onPress={onIAmWaiting}
            style={({ pressed }) => [styles.cta, (pressed || busy) && styles.pressed]}
          >
            <Text style={styles.ctaLabel}>أنا مستني هون</Text>
          </Pressable>
        ) : (
          <View style={{ gap: spacing.md }}>
            <Pressable
              testID="boarded-button"
              disabled={busy}
              onPress={onBoard}
              style={({ pressed }) => [styles.cta, (pressed || busy) && styles.pressed]}
            >
              <Text style={styles.ctaLabel}>ركبت</Text>
            </Pressable>
            <Pressable
              testID="cancel-wait-button"
              disabled={busy}
              onPress={onCancel}
              style={({ pressed }) => [styles.secondaryCta, (pressed || busy) && styles.pressed]}
            >
              <Text style={styles.secondaryCtaLabel}>إلغاء الانتظار</Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.surface },
  header: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    gap: 4,
  },
  back: { alignSelf: "flex-start", paddingVertical: spacing.xs },
  backLabel: { color: colors.brandPrimary, fontSize: fontSize.base },
  smallLabel: { color: colors.muted, fontSize: fontSize.base },
  destination: { color: colors.onSurface, fontSize: 30, fontWeight: "500" },
  body: { flex: 1, padding: spacing.lg, gap: spacing.lg },
  heroCard: {
    backgroundColor: colors.surfaceSecondary,
    padding: spacing.xl,
    borderRadius: radius.lg,
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  heroLabel: { color: colors.brandPrimary, fontSize: fontSize.lg, fontWeight: "500" },
  heroEta: { color: colors.onSurface, fontSize: 40, fontWeight: "500" },
  heroDist: { color: colors.muted, fontSize: fontSize.base },
  list: { gap: spacing.sm },
  listTitle: { color: colors.muted, fontSize: fontSize.base },
  otherRow: {
    backgroundColor: colors.surfaceSecondary,
    padding: spacing.md,
    borderRadius: radius.md,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  otherEta: { color: colors.onSurface, fontSize: fontSize.lg },
  otherDist: { color: colors.muted, fontSize: fontSize.base },
  confirmedCard: {
    backgroundColor: colors.brandTertiary,
    padding: spacing.lg,
    borderRadius: radius.md,
    gap: 4,
  },
  confirmedLabel: { color: colors.onBrandTertiary, fontSize: fontSize.lg, fontWeight: "500" },
  confirmedHint: { color: colors.onBrandTertiary, fontSize: fontSize.sm, opacity: 0.75 },
  errorText: { color: colors.error, fontSize: fontSize.base },
  footer: {
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
  secondaryCta: {
    backgroundColor: colors.surfaceSecondary,
    paddingVertical: spacing.lg,
    borderRadius: radius.lg,
    alignItems: "center",
  },
  secondaryCtaLabel: { color: colors.error, fontSize: fontSize.lg, fontWeight: "500" },
  pressed: { opacity: 0.8 },
}));
