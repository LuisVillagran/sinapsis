/// <reference lib="dom" />
// Abre xterm.js en Chrome, escribe bytes ANSI reales y guarda una captura. Solo para desarrollo.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type Browser, type Page, chromium } from 'playwright-core';

const require = createRequire(import.meta.url);

const fontBase64 = (weight: number): string =>
  readFileSync(require.resolve(`@fontsource/jetbrains-mono/files/jetbrains-mono-latin-${weight}-normal.woff2`)).toString('base64');

export interface CaptureOptions {
  cols: number;
  rows: number;
  /** Tamaño de letra. 15 da celdas de 9 px de ancho, lo más cercano a los 8,875 px de la referencia. */
  fontSize?: number;
  /** Multiplicador de alto. 1 es una terminal común; unos 1,15 imitan la celda alta de la referencia. */
  lineHeight?: number;
  background?: string;
}

export class XtermCapture {
  private constructor(
    private readonly browser: Browser,
    private readonly page: Page,
  ) {}

  static async open(options: CaptureOptions): Promise<XtermCapture> {
    const args = (process.env.SINAPSIS_CHROME_ARGS ?? '--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist').split(' ').filter(Boolean);
    const browser = await chromium.launch({ channel: 'chrome', headless: true, args });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1400 }, deviceScaleFactor: 1 });
    // Una pestaña caída también produce un PNG: sin esto se confundiría con una captura válida.
    page.on('crash', () => {
      process.stderr.write('Error: la pestaña de Chrome se cayó durante la captura\n');
      process.exit(2);
    });
    const css = readFileSync(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8');
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      @font-face { font-family: 'JetBrains Mono'; font-weight: 400; src: url(data:font/woff2;base64,${fontBase64(400)}) format('woff2'); }
      @font-face { font-family: 'JetBrains Mono'; font-weight: 700; src: url(data:font/woff2;base64,${fontBase64(700)}) format('woff2'); }
      ${css}
      html, body { margin: 0; background: ${options.background ?? '#11192c'}; }
      .xterm-viewport { overflow: hidden !important; }
    </style></head><body><div id="terminal" style="display:inline-block"></div></body></html>`);
    await page.addScriptTag({ path: require.resolve('@xterm/xterm/lib/xterm.js') });
    await page.addScriptTag({ path: require.resolve('@xterm/addon-webgl/lib/addon-webgl.js') });
    // La fuente debe estar cargada antes de abrir xterm, o mide las celdas con otra.
    const renderer = await page.evaluate(async (o) => {
      const fonts = (document as unknown as { fonts: { load(f: string): Promise<unknown>; ready: Promise<unknown> } }).fonts;
      await fonts.load("400 16px 'JetBrains Mono'");
      await fonts.load("700 16px 'JetBrains Mono'");
      await fonts.ready;
      const w = window as unknown as Record<string, any>;
      const term = new w.Terminal({
        cols: o.cols,
        rows: o.rows,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: o.fontSize ?? 15,
        lineHeight: o.lineHeight ?? 1,
        letterSpacing: 0,
        allowProposedApi: true,
        cursorBlink: false,
        scrollback: 0,
        theme: { background: o.background ?? '#11192c' },
      });
      term.open(document.getElementById('terminal'));
      let kind = 'dom';
      try {
        term.loadAddon(new w.WebglAddon.WebglAddon());
        kind = 'webgl';
      } catch {
        // Sin WebGL queda el renderizador del DOM.
      }
      w.term = term;
      return kind;
    }, options);
    if (renderer !== 'webgl') process.stderr.write('Aviso: captura sin WebGL\n');
    return new XtermCapture(browser, page);
  }

  async write(bytes: string): Promise<void> {
    await this.page.evaluate((data) => new Promise<void>((resolve) => (window as unknown as { term: { write(d: string, cb: () => void): void } }).term.write(data, resolve)), bytes);
  }

  async screenshot(path: string): Promise<{ width: number; height: number }> {
    const element = this.page.locator('.xterm-screen');
    await this.page.waitForTimeout(60);
    await element.screenshot({ path });
    const box = await element.boundingBox();
    return { width: Math.round(box?.width ?? 0), height: Math.round(box?.height ?? 0) };
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}
