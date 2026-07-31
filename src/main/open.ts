import { shell } from 'electron';

/**
 * Open a URL externally, but only https. One gate for every path that opens a
 * link (notification clicks, the popover's IPC handler), so a non-https /
 * `javascript:` / `file:` value — however it reached us — is never launched.
 */
export const openExternalSafe = (url: string): void => {
  if (/^https:\/\//i.test(url)) void shell.openExternal(url);
};
