// Renders public/icons/icon-*.png from the StreamHunter SVG mark using the preinstalled Chromium.
const { chromium } = require("playwright");
const path = require("node:path");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#6366f1"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#g)"/><path d="M9 12V9h3M20 9h3v3M23 20v3h-3M12 23H9v-3" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 12.6v6.8a.6.6 0 0 0 .9.5l5.4-3.4a.6.6 0 0 0 0-1l-5.4-3.4a.6.6 0 0 0-.9.5Z" fill="#fff"/></svg>`;
(async () => {
  const browser = await chromium.launch();
  for (const size of [16, 32, 48, 128]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: path.join(__dirname, "..", "public", "icons", `icon-${size}.png`), omitBackground: true });
    await page.close();
  }
  await browser.close();
})();
