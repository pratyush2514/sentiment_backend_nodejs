export type ProductWindowScope = "active" | "archive" | "live";

export const PRODUCT_WINDOW_POLICY = {
  defaultScope: "active" as const,
  activeWindowDays: 7,
  archiveWindowDays: 30,
  liveWindowHours: 24,
};

export function normalizeProductWindowScope(
  scope?: string | null,
  fallback: ProductWindowScope = PRODUCT_WINDOW_POLICY.defaultScope,
): ProductWindowScope {
  switch (scope) {
    case "active":
    case "archive":
    case "live":
      return scope;
    default:
      return fallback;
  }
}

export function getProductWindowStartTs(
  scope: ProductWindowScope,
  nowMs: number = Date.now(),
): string | null {
  switch (scope) {
    case "active":
      return String(
        (nowMs - PRODUCT_WINDOW_POLICY.activeWindowDays * 86_400_000) / 1000,
      );
    case "live":
      return String(
        (nowMs - PRODUCT_WINDOW_POLICY.liveWindowHours * 3_600_000) / 1000,
      );
    case "archive":
    default:
      return null;
  }
}

export function getProductWindowPolicyPayload(
  defaultScope: ProductWindowScope = PRODUCT_WINDOW_POLICY.defaultScope,
) {
  return {
    defaultScope,
    activeWindowDays: PRODUCT_WINDOW_POLICY.activeWindowDays,
    archiveWindowDays: PRODUCT_WINDOW_POLICY.archiveWindowDays,
    liveWindowHours: PRODUCT_WINDOW_POLICY.liveWindowHours,
  };
}
