// Design tokens for Mowasalat. Filled from /app/design_guidelines.json.
// Earthy Levantine palette. Light theme only for MVP.

import { useMemo } from "react";
import { Appearance, StyleSheet, useColorScheme } from "react-native";

export type ColorScheme = "light" | "dark";

const light = {
  // Surfaces (warm off-whites)
  surface: "#FAF8F5",
  onSurface: "#2C2B29",
  surfaceSecondary: "#F2EFEB",
  onSurfaceSecondary: "#2C2B29",
  surfaceTertiary: "#EAE6DF",
  onSurfaceTertiary: "#2C2B29",
  surfaceInverse: "#2C2B29",
  onSurfaceInverse: "#FAF8F5",
  muted: "#75726C",

  // Brand (olive green + sand)
  brand: "#586A45",
  onBrand: "#FFFFFF",
  brandPrimary: "#586A45",
  onBrandPrimary: "#FFFFFF",
  brandSecondary: "#8C7B5D",
  onBrandSecondary: "#FFFFFF",
  brandTertiary: "#D6D1C4",
  onBrandTertiary: "#2C2B29",

  // Status (earthy)
  success: "#4A7C59",
  onSuccess: "#FFFFFF",
  warning: "#C69036",
  onWarning: "#2C2B29",
  error: "#A64B32",
  onError: "#FFFFFF",
  info: "#606A61",
  onInfo: "#FFFFFF",

  // Lines
  border: "#E2DFD8",
  borderStrong: "#C2BCAE",
  divider: "#E8E5DF",
};

export type ThemeColors = typeof light;

export const defaultScheme = "light" satisfies ColorScheme;
export const themes: { light: ThemeColors; dark?: ThemeColors } = { light };

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 };
export const radius = { sm: 6, md: 12, lg: 20, pill: 999 };
export const fontSize = { sm: 12, base: 14, lg: 16, xl: 20, xxl: 24, display: 44 };

export function setColorScheme(scheme: ColorScheme | null) {
  Appearance.setColorScheme?.(scheme ?? "unspecified");
}
setColorScheme?.(themes.dark ? null : defaultScheme);

export function useTheme(): { scheme: ColorScheme; colors: ThemeColors } {
  const system = useColorScheme();
  const scheme: ColorScheme = system && themes[system] ? system : defaultScheme;
  return { scheme, colors: themes[scheme] ?? themes.light };
}

export const colors = themes.light;

export function makeStyles<T extends StyleSheet.NamedStyles<T> | StyleSheet.NamedStyles<any>>(
  factory: (colors: ThemeColors) => T & StyleSheet.NamedStyles<any>,
): () => T {
  return function useStyles(): T {
    const { colors } = useTheme();
    return useMemo(() => StyleSheet.create(factory(colors)), [colors]);
  };
}
