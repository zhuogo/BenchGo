import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/** Rasterize the canonical artwork; Android only adds adaptive-icon safe space. */
export async function prepareAndroidBrand(root = repositoryRoot) {
  const require = createRequire(join(root, 'deepseek-harness/apps/desktop/package.json'));
  const sharp = require('sharp');
  const brand = join(root, 'assets/brand');
  const resources = join(root, 'plugins/link/mobile/android/app/src/main/res');
  const [app, mark] = await Promise.all([
    readFile(join(brand, 'benchgo-app.svg')),
    readFile(join(brand, 'benchgo-mark.svg')),
  ]);
  const background = /<rect\b[^>]*\bfill="(#[\da-f]{6})"/i.exec(app.toString('utf8'))?.[1];
  if (!background) throw new Error('BenchGo app master must declare its background color');
  const save = async (path, contents) => {
    const target = join(resources, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  };

  for (const [density, size] of [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]]) {
    await save(`mipmap-${density}/ic_benchgo.png`, await sharp(app).resize(size, size).png().toBuffer());
  }
  // A dedicated bitmap prevents <bitmap> from resolving the adaptive mipmap XML.
  await save('drawable-nodpi/ic_benchgo_art.png', await sharp(app).resize(432, 432).png().toBuffer());

  // 108dp layer at xxxhdpi. Keep the complete transparent 840x760 mark at 84dp
  // wide: its 600px-wide body becomes 60dp and fits the 66dp safe circle.
  const foreground = await sharp(mark).resize({ width: 336 }).png().toBuffer();
  await save('drawable-nodpi/ic_benchgo_foreground_art.png', await sharp({
    create: { width: 432, height: 432, channels: 4, background: '#00000000' },
  }).composite([{ input: foreground, gravity: 'centre' }]).png().toBuffer());
  await save('values/colors.xml', `<resources>\n    <color name="benchgo_brand_background">${background}</color>\n</resources>\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareAndroidBrand();
}
