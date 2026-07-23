// =====================================================================
// utils/generate_icons.js — Rasterize SVG PWA icons using Sharp
// =====================================================================
'use strict';

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

async function generateIcons() {
  try {
    const iconsDir = path.join(__dirname, '..', 'public', 'icons');
    if (!fs.existsSync(iconsDir)) {
      fs.mkdirSync(iconsDir, { recursive: true });
    }

    const svgPath = path.join(iconsDir, 'icon.svg');
    if (!fs.existsSync(svgPath)) {
      throw new Error(`Source SVG not found at: ${svgPath}`);
    }

    console.log('[generate_icons] starting icon rasterization from SVG...');

    // Read the SVG content into a buffer so sharp handles it correctly
    const svgBuffer = fs.readFileSync(svgPath);

    // 1. Generate icon-192.png (192x192)
    await sharp(svgBuffer)
      .resize(192, 192)
      .png()
      .toFile(path.join(iconsDir, 'icon-192.png'));
    console.log('[generate_icons] generated icon-192.png (192x192)');

    // 2. Generate icon-512.png (512x512)
    await sharp(svgBuffer)
      .resize(512, 512)
      .png()
      .toFile(path.join(iconsDir, 'icon-512.png'));
    console.log('[generate_icons] generated icon-512.png (512x512)');

    // 3. Generate apple-touch-icon.png (180x180, flattened onto a solid #020617 background, no alpha transparency)
    await sharp(svgBuffer)
      .resize(180, 180)
      .flatten({ background: '#020617' })
      .png({ progressive: true })
      .toFile(path.join(iconsDir, 'apple-touch-icon.png'));
    console.log('[generate_icons] generated apple-touch-icon.png (180x180)');

    console.log('[generate_icons] all icons rasterized successfully!');
  } catch (err) {
    console.error('[generate_icons] error during icon generation:', err);
    process.exit(1);
  }
}

// Support running directly from command line
if (require.main === module) {
  generateIcons();
}

module.exports = { generateIcons };
