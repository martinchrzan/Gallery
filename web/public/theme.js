/*
 * Applies the light or dark theme before the first paint.
 *
 * The bundle is a deferred module, so on its own the page would paint once in
 * the light theme and then flip — a white flash on every load for anyone who
 * chose dark. This runs synchronously in <head> instead, ahead of the
 * stylesheet. It is a plain file rather than an inline script because the
 * server's Content-Security-Policy allows scripts from this origin only.
 *
 * From here on src/lib/theme.ts takes over. Keep the storage key and the dark
 * page colour below in step with that file and with styles.css.
 */
(function () {
  var theme = null;
  try {
    theme = localStorage.getItem('gallery.theme');
  } catch (e) {
    // Storage blocked: fall through to the device's own preference.
  }
  if (theme !== 'light' && theme !== 'dark') {
    theme =
      window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
  }

  var root = document.documentElement;
  root.setAttribute('data-theme', theme);

  // Before the stylesheet arrives, these two decide the colour of the blank
  // page and of the browser's own chrome around it.
  var scheme = document.querySelector('meta[name="color-scheme"]');
  if (scheme) scheme.setAttribute('content', theme);
  var chrome = document.querySelector('meta[name="theme-color"]');
  if (chrome) chrome.setAttribute('content', theme === 'dark' ? '#111316' : '#ffffff');
})();
