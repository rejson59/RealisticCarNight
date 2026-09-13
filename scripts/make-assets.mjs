/**
 * Build helper: derives the PWA icons, OG banner and apple-touch icon from
 * design/og-src.png. Deterministic, no external assets. Run:
 *   node scripts/make-assets.mjs
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, '..', 'public');

const SRC = join(here, '..', 'design', 'og-src.png');

async function main() {
  await mkdir(join(pub, 'icons'), { recursive: true });
  const img = await loadImage(SRC);

  /* ---- OG banner 1200x630 ---- */
  {
    const W = 1200, H = 630;
    const c = createCanvas(W, H);
    const g = c.getContext('2d');
    const aspect = W / H;
    let sw = img.width, sh = img.width / aspect;
    if (sh > img.height) { sh = img.height; sw = img.height * aspect; }
    const sx = (img.width - sw) / 2;
    const sy = (img.height - sh) * 0.42;      // keep the car low-centre in frame
    g.drawImage(img, sx, Math.max(0, sy), sw, sh, 0, 0, W, H);
    const grad = g.createLinearGradient(0, H * 0.62, 0, H);
    grad.addColorStop(0, 'rgba(5,7,13,0)');
    grad.addColorStop(1, 'rgba(5,7,13,0.72)');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#eaf6ff';
    g.font = '700 54px system-ui, sans-serif';
    g.fillText('REALISTIC', 44, H - 84);
    g.fillStyle = '#28d7fe';
    g.fillText('CAR', 44 + g.measureText('REALISTIC').width + 14, H - 84);
    g.fillStyle = '#eaf6ff';
    g.fillText('NIGHT', 44 + g.measureText('REALISTIC').width + 14 + g.measureText('CAR').width + 14, H - 84);
    g.fillStyle = 'rgba(159,220,239,.85)';
    g.font = '500 24px system-ui, sans-serif';
    g.fillText('nocne miasto • mokry asfalt • neonowe odbicia • w przeglądarce', 46, H - 42);
    const buf = c.toBuffer('image/jpeg', 86);
    await writeFile(join(pub, 'og.jpg'), buf);
    console.log('public/og.jpg', buf.length, 'bytes');
  }

  /* ---- square app icons ---- */
  const square = (size) => {
    const c = createCanvas(size, size);
    const g = c.getContext('2d');
    const s = Math.min(img.width, img.height);
    const sx = Math.round(img.width * 0.17);
    const sy = Math.max(0, Math.round(img.height * 0.06));
    const side = Math.min(s, img.height - sy);
    g.drawImage(img, sx, sy, side, side, 0, 0, size, size);
    const grad = g.createLinearGradient(0, size * 0.55, 0, size);
    grad.addColorStop(0, 'rgba(5,7,13,0)');
    grad.addColorStop(1, 'rgba(5,7,13,0.55)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return c;
  };

  {
    // 192 png (apple-touch + fallback), 512 as webp (small photographic icon)
    const c192 = square(192);
    const buf192 = c192.toBuffer('image/png');
    await writeFile(join(pub, 'icons', 'icon-192.png'), buf192);
    console.log('public/icons/icon-192.png', buf192.length, 'bytes');

    const c512 = square(512);
    const buf512 = c512.toBuffer('image/webp', 82);
    await writeFile(join(pub, 'icons', 'icon-512.webp'), buf512);
    console.log('public/icons/icon-512.webp', buf512.length, 'bytes');

    // maskable: padded artwork on the app background
    const size = 512;
    const c = createCanvas(size, size);
    const g = c.getContext('2d');
    g.fillStyle = '#05070d';
    g.fillRect(0, 0, size, size);
    const pad = Math.round(size * 0.16);
    g.drawImage(square(size - pad * 2), pad, pad);
    const bufM = c.toBuffer('image/webp', 82);
    await writeFile(join(pub, 'icons', 'icon-maskable-512.webp'), bufM);
    console.log('public/icons/icon-maskable-512.webp', bufM.length, 'bytes');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
