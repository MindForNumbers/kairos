/**
 * AG Studio theme for /reports. Every value points at a Kairos CSS variable from app/globals.css,
 * which already switches for dark mode, so Studio's UI, grids and charts follow light/dark with the
 * rest of the app. Teal accent; neutral surfaces.
 */
import { studioTheme } from "ag-studio";

const v = (name: string) => `var(--${name})`;
const line = (color: string) => ({ width: 1, color: v(color) });
// Teal-led categorical palette (accent first), then muted neutrals.
const PALETTE = ["var(--accent)", "#3a9e8c", "#7cc4b5", "#b54708", "#6b6b6b", "#0b4f44", "#a6d9cf", "#d08a3c", "#9a9a9a", "#2c7a6c"];
const palette = Object.fromEntries(PALETTE.flatMap((c, i) => [[`chartPaletteFills${i + 1}Color`, c], [`chartPaletteStrokes${i + 1}Color`, c]]));
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

export const kairosStudioTheme = studioTheme.withParams({
  fontFamily: FONT,
  fontSize: 14,
  textColor: v("text"),
  foregroundColor: v("text"),
  subtleTextColor: v("muted"),
  backgroundColor: v("surface"),
  borderColor: v("border"),
  accentColor: v("accent"),
  iconColor: v("muted"),
  rowHoverColor: v("accent-soft"),

  studioWrapperBorder: false,
  studioWrapperBorderRadius: 0,
  studioWrapperSpacing: 0,
  studioWrapperBackgroundColor: v("bg"),
  studioCanvasBorder: false,
  studioCanvasBorderRadius: 0,
  studioCanvasShadow: false,
  studioCanvasBackgroundColor: v("bg"),
  studioCanvasPadding: 8,
  studioCanvasRowHeight: 18,
  studioCanvasFontFamily: FONT,

  studioWidgetBackgroundColor: v("surface"),
  studioWidgetBorder: line("border"),
  studioWidgetBorderRadius: 10,
  studioWidgetPadding: 10,
  studioWidgetTitleFontFamily: FONT,
  studioWidgetTitleFontSize: 15,
  studioWidgetTitleFontWeight: 600,
  studioWidgetTitleTextColor: v("text"),
  studioWidgetSubtitleTextColor: v("muted"),
  studioWidgetCaptionTextColor: v("muted"),
  studioWidgetResizeBorderColor: v("accent"),

  studioPanelContainerBackgroundColor: v("surface"),
  studioPanelContainerBorder: line("border"),
  studioPanelDividerColor: v("border"),
  studioPanelDividerActiveColor: v("accent"),
  studioPanelSectionBorderColor: v("border"),
  studioToggleButtonActiveBackgroundColor: v("accent-soft"),
  studioToggleButtonActiveBorderColor: v("accent"),
  studioToggleButtonActiveColor: v("accent"),

  gridFontFamily: FONT,
  gridFontSize: 13,
  gridCellTextColor: v("text"),
  gridHeaderBackgroundColor: v("surface"),
  gridHeaderTextColor: v("muted"),
  gridHeaderFontWeight: 600,
  gridRowHeight: 38,
  gridRowBorder: line("border"),
  gridHeaderRowBorder: line("border"),
  gridRowHoverColor: v("accent-soft"),
  gridWrapperBorder: false,

  chartFontFamily: FONT,
  chartTextColor: v("text"),
  chartSubtleTextColor: v("muted"),
  chartAxisLineColor: v("border"),
  chartGridLineColor: v("border"),
  ...palette,
});
