import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/src/api";
import { store } from "@/src/storage";
import { makeStyles, spacing, radius, fontSize, useTheme } from "@/src/theme";

export default function DriverLogin() {
  const router = useRouter();
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("+9627");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    (async () => {
      const s = await store.getDriverSession();
      if (s) router.replace("/driver/routes");
      setCheckingSession(false);
    })();
  }, [router]);

  const sendCode = async () => {
    setErr(null);
    setLoading(true);
    try {
      await api.otpRequest(phone);
      setStep("code");
    } catch (e: any) {
      setErr(e.message || "خطأ");
    } finally {
      setLoading(false);
    }
  };

  const verify = async () => {
    setErr(null);
    setLoading(true);
    try {
      const s = await api.otpVerify(phone, code);
      await store.saveDriverSession(s);
      router.replace("/driver/routes");
    } catch (e: any) {
      setErr(e.message || "الرمز غير صحيح");
    } finally {
      setLoading(false);
    }
  };

  if (checkingSession) {
    return (
      <View style={[styles.container, styles.center]} testID="driver-login-loading">
        <ActivityIndicator color={colors.brandPrimary} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <View style={styles.container} testID="driver-login-screen">
        <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
          <Pressable onPress={() => router.back()} testID="driver-login-back" hitSlop={8}>
            <Text style={styles.back}>رجوع</Text>
          </Pressable>
          <Text style={styles.title}>تسجيل السائق</Text>
          <Text style={styles.subtitle}>
            {step === "phone" ? "أدخل رقم هاتفك" : "أدخل الرمز المرسل (٦ أرقام)"}
          </Text>
        </View>

        <View style={styles.body}>
          {step === "phone" ? (
            <View style={{ gap: spacing.sm }}>
              <Text style={styles.label}>رقم الهاتف</Text>
              <TextInput
                testID="driver-phone-input"
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
                style={styles.input}
                placeholder="+962 7X XXX XXXX"
                placeholderTextColor={colors.muted}
                textAlign="left"
              />
            </View>
          ) : (
            <View style={{ gap: spacing.sm }}>
              <Text style={styles.label}>الرمز (أي ٦ أرقام للتجربة)</Text>
              <TextInput
                testID="driver-otp-input"
                value={code}
                onChangeText={(t) => setCode(t.replace(/\D/g, "").slice(0, 6))}
                keyboardType="number-pad"
                style={[styles.input, styles.codeInput]}
                placeholder="123456"
                placeholderTextColor={colors.muted}
                textAlign="center"
                maxLength={6}
              />
              <Pressable
                onPress={() => {
                  setStep("phone");
                  setCode("");
                }}
                testID="driver-change-phone"
              >
                <Text style={styles.link}>تغيير رقم الهاتف</Text>
              </Pressable>
            </View>
          )}
          {err ? (
            <Text testID="driver-login-error" style={styles.err}>
              {err}
            </Text>
          ) : null}
        </View>

        <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
          {step === "phone" ? (
            <Pressable
              testID="driver-send-code"
              disabled={loading || phone.length < 6}
              onPress={sendCode}
              style={({ pressed }) => [
                styles.cta,
                (pressed || loading || phone.length < 6) && styles.pressed,
              ]}
            >
              <Text style={styles.ctaLabel}>{loading ? "..." : "إرسال الرمز"}</Text>
            </Pressable>
          ) : (
            <Pressable
              testID="driver-verify-code"
              disabled={loading || code.length !== 6}
              onPress={verify}
              style={({ pressed }) => [
                styles.cta,
                (pressed || loading || code.length !== 6) && styles.pressed,
              ]}
            >
              <Text style={styles.ctaLabel}>{loading ? "..." : "تحقق"}</Text>
            </Pressable>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
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
  back: { color: colors.brandPrimary, fontSize: fontSize.base, paddingVertical: spacing.xs },
  title: { color: colors.onSurface, fontSize: 30, fontWeight: "500" },
  subtitle: { color: colors.muted, fontSize: fontSize.base },
  body: { flex: 1, padding: spacing.lg, gap: spacing.lg },
  label: { color: colors.muted, fontSize: fontSize.base },
  input: {
    backgroundColor: colors.surfaceTertiary,
    color: colors.onSurface,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md + 2,
    fontSize: fontSize.xl,
  },
  codeInput: { letterSpacing: 8, fontSize: 28, textAlign: "center" },
  link: { color: colors.brandPrimary, fontSize: fontSize.base, paddingVertical: spacing.xs },
  err: { color: colors.error, fontSize: fontSize.base },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
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
  pressed: { opacity: 0.7 },
}));
