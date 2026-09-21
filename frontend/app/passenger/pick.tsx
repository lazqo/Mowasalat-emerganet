// Which line, and where on it? Resolves the passenger's route-relative
// position from a single foreground GPS fix projected locally onto each
// candidate corridor, or from a stop they choose. No location stream, no
// background location, and the coordinate never leaves this screen.
import * as Location from "expo-location";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, TransportRoute } from "@/src/api";
import { getCorridors } from "@/src/corridors";
import { Corridor, CorridorStop } from "@/src/geo/corridor";
import { candidateLines, LineCandidate, LineMatch, matchLines, stopsBeforeDestination } from "@/src/geo/lines";
import { makeStyles, spacing, radius, fontSize, useTheme } from "@/src/theme";

type Phase = "loading" | "locating" | "choose" | "stops" | "error";

export default function PassengerPick() {
  const router = useRouter();
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ destination_id: string; destination_name: string }>();

  const [phase, setPhase] = useState<Phase>("loading");
  const [routes, setRoutes] = useState<TransportRoute[]>([]);
  const [corridors, setCorridors] = useState<Record<string, Corridor>>({});
  const [matches, setMatches] = useState<LineMatch[] | null>(null); // null = no usable fix
  const [locationNote, setLocationNote] = useState<string | null>(null);
  const [manualLine, setManualLine] = useState<LineCandidate | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const candidates = useMemo(() => candidateLines(routes, params.destination_id!), [routes, params.destination_id]);

  const go = (line: LineCandidate, where: { wait_progress_km?: number; stop_id?: string; stop_name?: string }) => {
    router.replace({
      pathname: "/passenger/waiting",
      params: {
        destination_id: params.destination_id!,
        destination_name: params.destination_name!,
        route_id: line.route_id,
        route_name: line.route_name_ar,
        direction: String(line.direction),
        ...(where.wait_progress_km !== undefined ? { wait_progress_km: String(where.wait_progress_km) } : {}),
        ...(where.stop_id ? { stop_id: where.stop_id, stop_name: where.stop_name ?? "" } : {}),
      },
    });
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.listRoutes();
        if (cancelled) return;
        setRoutes(r);
        const cands = candidateLines(r, params.destination_id!);
        if (cands.length === 0) {
          setErr("لا يوجد خط يخدم هذه الوجهة");
          setPhase("error");
          return;
        }
        const cs = await getCorridors([...new Set(cands.map((c) => c.route_id))]);
        if (cancelled) return;
        setCorridors(cs);
        setPhase("locating");
        const fix = await oneFix();
        if (cancelled) return;
        if (fix) {
          const m = matchLines(cands, cs, fix[0], fix[1]);
          setMatches(m);
          const ok = m.filter((x) => x.ok);
          if (ok.length === 1) {
            go(ok[0], { wait_progress_km: ok[0].progress_km });
            return;
          }
          if (ok.length === 0) setLocationNote("لست على أي خط يخدم وجهتك، اختر الموقف الذي تنتظر فيه");
        } else {
          setLocationNote("لم نتمكن من تحديد موقعك، اختر الموقف الذي تنتظر فيه");
        }
        setPhase("choose");
      } catch (e: any) {
        if (cancelled) return;
        setErr(e.message || "خطأ في التحميل");
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.destination_id]);

  const okMatches = (matches ?? []).filter((m) => m.ok);
  const stopsFor = (line: LineCandidate): CorridorStop[] =>
    corridors[line.route_id] ? stopsBeforeDestination(line, corridors[line.route_id]) : [];

  return (
    <View style={styles.container} testID="passenger-pick-screen">
      <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <Pressable onPress={() => router.back()} style={styles.back} hitSlop={8} testID="pick-back-button">
          <Text style={styles.backLabel}>رجوع</Text>
        </Pressable>
        <Text style={styles.smallLabel}>إلى</Text>
        <Text style={styles.title}>{params.destination_name}</Text>
      </View>

      {phase === "loading" || phase === "locating" ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brandPrimary} />
          <Text style={styles.muted}>{phase === "locating" ? "جاري تحديد مكانك على الخط..." : "..."}</Text>
        </View>
      ) : phase === "error" ? (
        <View style={styles.center}>
          <Text style={styles.err}>{err}</Text>
        </View>
      ) : phase === "stops" && manualLine ? (
        <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm, paddingBottom: insets.bottom + spacing.xl }}>
          <Text style={styles.sectionTitle}>{manualLine.route_name_ar} · وين واقف؟</Text>
          {stopsFor(manualLine).map((s) => (
            <Pressable
              key={s.stop_id}
              testID={`stop-option-${s.stop_id}`}
              onPress={() => go(manualLine, { stop_id: s.stop_id, stop_name: s.name_ar })}
              style={({ pressed }) => [styles.card, pressed && styles.pressed]}
            >
              <Text style={styles.cardTitle}>{s.name_ar}</Text>
              <Text style={styles.cardSub}>{s.kind === "hub" ? "المجمع" : `${s.progress_km.toFixed(1)} كم من البداية`}</Text>
            </Pressable>
          ))}
          <Pressable onPress={() => setPhase("choose")} testID="stops-back">
            <Text style={styles.link}>خط آخر</Text>
          </Pressable>
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm, paddingBottom: insets.bottom + spacing.xl }}>
          {locationNote ? <Text style={styles.note}>{locationNote}</Text> : null}
          {okMatches.length > 0 ? (
            <>
              <Text style={styles.sectionTitle}>خطوط تمر من مكانك</Text>
              {okMatches.map((m) => (
                <Pressable
                  key={`${m.route_id}/${m.direction}`}
                  testID={`line-option-${m.route_id}-${m.direction}`}
                  onPress={() => go(m, { wait_progress_km: m.progress_km })}
                  style={({ pressed }) => [styles.card, styles.cardOk, pressed && styles.pressed]}
                >
                  <Text style={styles.cardTitle}>{m.route_name_ar}</Text>
                  <Text style={styles.cardSub}>{m.origin_name_ar} ← {m.destination_name_ar}</Text>
                </Pressable>
              ))}
            </>
          ) : null}
          <Text style={styles.sectionTitle}>{okMatches.length ? "أو اختر الموقف يدوياً" : "اختر الخط ثم الموقف"}</Text>
          {candidates.map((c) => (
            <Pressable
              key={`m-${c.route_id}/${c.direction}`}
              testID={`manual-line-${c.route_id}-${c.direction}`}
              onPress={() => {
                setManualLine(c);
                setPhase("stops");
              }}
              style={({ pressed }) => [styles.card, pressed && styles.pressed]}
            >
              <Text style={styles.cardTitle}>{c.route_name_ar}</Text>
              <Text style={styles.cardSub}>{c.origin_name_ar} ← {c.destination_name_ar}</Text>
            </Pressable>
          ))}
          <Text style={styles.footnote}>موقعك يُحسب على جهازك فقط ولا يُرسل إلى الخادم.</Text>
        </ScrollView>
      )}
    </View>
  );
}

/** One foreground fix, or null if denied/unavailable. Never a stream. */
async function oneFix(): Promise<[number, number] | null> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return null;
    const loc = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 12000)),
    ]);
    if (!loc) {
      const last = await Location.getLastKnownPositionAsync({ maxAge: 5 * 60 * 1000 });
      if (!last) return null;
      return [last.coords.longitude, last.coords.latitude];
    }
    return [loc.coords.longitude, loc.coords.latitude];
  } catch {
    return null;
  }
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.surface },
  header: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.divider, gap: 4 },
  back: { alignSelf: "flex-start", paddingVertical: spacing.xs },
  backLabel: { color: colors.brandPrimary, fontSize: fontSize.base },
  smallLabel: { color: colors.muted, fontSize: fontSize.base },
  title: { color: colors.onSurface, fontSize: 30, fontWeight: "500" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md, padding: spacing.xl },
  muted: { color: colors.muted, fontSize: fontSize.base },
  err: { color: colors.error, fontSize: fontSize.base },
  note: { color: colors.onSurface, backgroundColor: colors.surfaceTertiary, padding: spacing.md, borderRadius: radius.md, fontSize: fontSize.base },
  sectionTitle: { color: colors.muted, fontSize: fontSize.base, marginTop: spacing.md },
  card: { backgroundColor: colors.surfaceSecondary, padding: spacing.lg, borderRadius: radius.md, gap: 4, borderWidth: 2, borderColor: "transparent" },
  cardOk: { borderColor: colors.brandPrimary, backgroundColor: colors.brandTertiary },
  cardTitle: { color: colors.onSurface, fontSize: fontSize.xl, fontWeight: "500" },
  cardSub: { color: colors.muted, fontSize: fontSize.base },
  link: { color: colors.brandPrimary, fontSize: fontSize.base, paddingVertical: spacing.md },
  footnote: { color: colors.muted, fontSize: fontSize.sm, marginTop: spacing.lg },
  pressed: { opacity: 0.75 },
}));
