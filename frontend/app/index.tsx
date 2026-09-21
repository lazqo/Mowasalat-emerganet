import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { makeStyles, spacing, radius, fontSize } from "@/src/theme";

const HERO_URI =
  "https://images.unsplash.com/photo-1571685330542-0da6a6a8edc2?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjA1ODh8MHwxfHNlYXJjaHwxfHxqb3JkYW4lMjBsYW5kc2NhcGUlMjBhZXN0aGV0aWMlMjBtaW5pbWFsfGVufDB8fHx8MTc4OTk3MTY0N3ww&ixlib=rb-4.1.0&q=85";

export default function Index() {
  const router = useRouter();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.container} testID="role-selection-screen">
      <Image source={HERO_URI} style={styles.hero} contentFit="cover" transition={300} />
      <LinearGradient
        colors={["rgba(0,0,0,0)", "rgba(44,43,41,0.55)", "rgba(44,43,41,0.92)"]}
        locations={[0, 0.5, 1]}
        style={styles.scrim}
      />
      <View style={[styles.content, { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + spacing.xl }]}>
        <View style={styles.top}>
          <Text style={styles.brand}>مواصلات</Text>
          <Text style={styles.tagline}>خطوطك المعتادة، معلومات حقيقية</Text>
        </View>
        <View style={styles.buttons}>
          <Pressable
            testID="passenger-role-button"
            onPress={() => router.push("/passenger")}
            style={({ pressed }) => [styles.primaryBtn, pressed && styles.pressed]}
          >
            <Text style={styles.primaryLabel}>راكب</Text>
            <Text style={styles.primarySub}>ابحث عن باص</Text>
          </Pressable>
          <Pressable
            testID="driver-role-button"
            onPress={() => router.push("/driver/login")}
            style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryLabel}>سائق</Text>
            <Text style={styles.secondarySub}>ابدأ رحلة</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.surfaceInverse },
  hero: { ...(require("react-native").StyleSheet.absoluteFillObject) },
  scrim: { ...(require("react-native").StyleSheet.absoluteFillObject) },
  content: { flex: 1, paddingHorizontal: spacing.xl, justifyContent: "space-between" },
  top: { alignItems: "flex-start", gap: spacing.sm, marginTop: spacing.xxxl },
  brand: { color: colors.onSurfaceInverse, fontSize: 48, fontWeight: "500", letterSpacing: -0.5 },
  tagline: { color: colors.onSurfaceInverse, fontSize: fontSize.lg, opacity: 0.85 },
  buttons: { gap: spacing.md },
  primaryBtn: {
    backgroundColor: colors.brandPrimary,
    paddingVertical: spacing.lg + 2,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.lg,
    alignItems: "flex-start",
    gap: 2,
  },
  primaryLabel: { color: colors.onBrandPrimary, fontSize: fontSize.xxl, fontWeight: "500" },
  primarySub: { color: colors.onBrandPrimary, fontSize: fontSize.base, opacity: 0.85 },
  secondaryBtn: {
    backgroundColor: colors.surface,
    paddingVertical: spacing.lg + 2,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.lg,
    alignItems: "flex-start",
    gap: 2,
  },
  secondaryLabel: { color: colors.onSurface, fontSize: fontSize.xxl, fontWeight: "500" },
  secondarySub: { color: colors.muted, fontSize: fontSize.base },
  pressed: { opacity: 0.85 },
}));
