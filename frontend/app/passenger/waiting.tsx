// Live view of approaching buses for the chosen line, via server-sent
// events. The passenger's position was resolved on the previous screen as a
// route-relative km or a chosen stop; nothing else is sent.
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, ApproachingBus, WaitOut } from "@/src/api";
import { useSSE } from "@/src/realtime/sse";
import { makeStyles, spacing, radius, fontSize, useTheme } from "@/src/theme";

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
    route_name: string;
    direction: string;
    wait_progress_km?: string;
    stop_id?: string;
    stop_name?: string;
  }>();
  const direction = Number(params.direction ?? 0);
  const positionKm = params.wait_progress_km !== undefined ? Number(params.wait_progress_km) : null;

  const [buses, setBuses] = useState<ApproachingBus[] | null>(null);
  const [wait, setWait] = useState<WaitOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  // Before "I'm waiting": buses stream for this line and position.
  const preQuery = new URLSearchParams({
    destination_id: params.destination_id!,
    route_id: params.route_id!,
    direction: String(direction),
    from_progress_km: String(positionKm ?? 0),
  }).toString();
  useSSE<{ buses: ApproachingBus[] }>(wait ? null : `/passenger/buses/stream?${preQuery}`, {
    event: "buses",
    onEvent: (d) => {
      setBuses(d.buses);
      setLive(true);
      setErr(null);
    },
    onError: () => setLive(false),
  });
  // After: the wait's own stream; `ended` means boarded/cancelled/expired.
  useSSE<{ buses: ApproachingBus[] }>(wait ? `/passenger/wait/${wait.wait_id}/stream` : null, {
    event: "status",
    onEvent: (d) => {
      setBuses(d.buses);
      setLive(true);
      setErr(null);
    },
    onEnded: () => {
      setWait(null);
      setErr("انتهى طلب الانتظار");
    },
    onError: () => setLive(false),
  });

  const onIAmWaiting = async () => {
    setBusy(true);
    try {
      const w = await api.createWait(params.destination_id!, params.route_id!, direction,
        params.stop_id ? { stop_id: params.stop_id } : { wait_progress_km: positionKm ?? 0 });
      setWait(w);
      setErr(null);
    } catch (e: any) {
      setErr(e.message || "خطأ");
    } finally {
      setBusy(false);
    }
  };

  const finish = async (action: "board" | "cancel") => {
    if (!wait) {
      router.back();
      return;
    }
    setBusy(true);
    try {
      if (action === "board") await api.waitBoard(wait.wait_id);
      else await api.waitCancel(wait.wait_id);
    } catch {}
    setBusy(false);
    router.replace("/passenger");
  };

  const nearest = buses && buses.length ? buses[0] : null;
  const whereLabel = params.stop_id ? `عند ${params.stop_name}` : positionKm !== null ? `على بعد ${positionKm.toFixed(1)} كم من بداية الخط` : "";

  return (
    <View style={styles.container} testID="passenger-waiting-screen">
      <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <Pressable onPress={() => finish("cancel")} style={styles.back} hitSlop={8} testID="waiting-back-button">
          <Text style={styles.backLabel}>رجوع</Text>
        </Pressable>
        <Text style={styles.smallLabel}>{params.route_name} · إلى</Text>
        <Text style={styles.destination}>{params.destination_name}</Text>
        <Text style={styles.where}>{whereLabel}</Text>
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
            <Text style={styles.heroDist}>{live ? "متصل، سيظهر الباص عند اقترابه" : "جاري الاتصال..."}</Text>
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
            <Text style={styles.confirmedLabel}>السائق يرى أن هناك راكباً بانتظاره</Text>
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
              onPress={() => finish("board")}
              style={({ pressed }) => [styles.cta, (pressed || busy) && styles.pressed]}
            >
              <Text style={styles.ctaLabel}>ركبت</Text>
            </Pressable>
            <Pressable
              testID="cancel-wait-button"
              disabled={busy}
              onPress={() => finish("cancel")}
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
  header: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.divider, gap: 4 },
  back: { alignSelf: "flex-start", paddingVertical: spacing.xs },
  backLabel: { color: colors.brandPrimary, fontSize: fontSize.base },
  smallLabel: { color: colors.muted, fontSize: fontSize.base },
  destination: { color: colors.onSurface, fontSize: 30, fontWeight: "500" },
  where: { color: colors.muted, fontSize: fontSize.sm },
  body: { flex: 1, padding: spacing.lg, gap: spacing.lg },
  heroCard: { backgroundColor: colors.surfaceSecondary, padding: spacing.xl, borderRadius: radius.lg, alignItems: "flex-start", gap: spacing.sm },
  heroLabel: { color: colors.brandPrimary, fontSize: fontSize.lg, fontWeight: "500" },
  heroEta: { color: colors.onSurface, fontSize: 40, fontWeight: "500" },
  heroDist: { color: colors.muted, fontSize: fontSize.base },
  list: { gap: spacing.sm },
  listTitle: { color: colors.muted, fontSize: fontSize.base },
  otherRow: { backgroundColor: colors.surfaceSecondary, padding: spacing.md, borderRadius: radius.md, flexDirection: "row", justifyContent: "space-between" },
  otherEta: { color: colors.onSurface, fontSize: fontSize.lg },
  otherDist: { color: colors.muted, fontSize: fontSize.base },
  confirmedCard: { backgroundColor: colors.brandTertiary, padding: spacing.lg, borderRadius: radius.md, gap: 4 },
  confirmedLabel: { color: colors.onBrandTertiary, fontSize: fontSize.lg, fontWeight: "500" },
  confirmedHint: { color: colors.onBrandTertiary, fontSize: fontSize.sm, opacity: 0.75 },
  errorText: { color: colors.error, fontSize: fontSize.base },
  footer: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.divider },
  cta: { backgroundColor: colors.brandPrimary, paddingVertical: spacing.lg + 2, borderRadius: radius.lg, alignItems: "center" },
  ctaLabel: { color: colors.onBrandPrimary, fontSize: fontSize.xl, fontWeight: "500" },
  secondaryCta: { backgroundColor: colors.surfaceSecondary, paddingVertical: spacing.lg, borderRadius: radius.lg, alignItems: "center" },
  secondaryCtaLabel: { color: colors.error, fontSize: fontSize.lg, fontWeight: "500" },
  pressed: { opacity: 0.8 },
}));
