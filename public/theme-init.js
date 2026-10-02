// Theme before first paint: the viewer's saved choice, else the system setting.
// A separate file rather than an inline <script> so the CSP can forbid inline scripts.
(function () {
  var theme;
  try {
    theme = localStorage.getItem('theme');
  } catch (e) {}
  if (theme !== 'light' && theme !== 'dark') theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  if (theme === 'dark') document.querySelector('meta[name="theme-color"]').setAttribute('content', '#0e0c0b');
})();
