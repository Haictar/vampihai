/**
 * Opens a website or app in a new browser tab. Never navigates the HAI tab itself: when the
 * browser blocks the new tab (voice has no click, so pop-up blockers often step in) it returns
 * false and the caller shows a button the person can tap instead.
 */
export function openInNewTab(
  url: string,
  open: (url: string, target: string) => Window | null,
): boolean {
  const opened = open(url, "_blank");
  if (!opened) return false;
  try {
    opened.opener = null;
  } catch {
    // Some browsers don't allow changing this; the tab is open either way.
  }
  return true;
}
