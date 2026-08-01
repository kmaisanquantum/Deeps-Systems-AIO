// =====================================================================
// utils/generate_icons.js — Rasterize SVG/PNG PWA icons using Sharp
// =====================================================================
'use strict';

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

async function rasterize(sourceInput, iconsDir) {
  // 1. Generate icon-192.png (192x192)
  await sharp(sourceInput)
    .resize(192, 192, { fit: 'contain', background: '#020617' })
    .png()
    .toFile(path.join(iconsDir, 'icon-192.png'));
  console.log('[generate_icons] generated icon-192.png (192x192)');

  // 2. Generate icon-512.png (512x512)
  await sharp(sourceInput)
    .resize(512, 512, { fit: 'contain', background: '#020617' })
    .png()
    .toFile(path.join(iconsDir, 'icon-512.png'));
  console.log('[generate_icons] generated icon-512.png (512x512)');

  // 3. Generate apple-touch-icon.png (180x180, flattened onto solid #020617, no alpha)
  await sharp(sourceInput)
    .resize(180, 180, { fit: 'contain', background: '#020617' })
    .flatten({ background: '#020617' })
    .png({ progressive: true })
    .toFile(path.join(iconsDir, 'apple-touch-icon.png'));
  console.log('[generate_icons] generated apple-touch-icon.png (180x180)');
}

async function generateIcons() {
  const iconsDir = path.join(__dirname, '..', 'public', 'icons');
  try {
    if (!fs.existsSync(iconsDir)) {
      fs.mkdirSync(iconsDir, { recursive: true });
    }
  } catch (err) {
    console.warn('[generate_icons] Failed to create icons directory:', err.message);
    return;
  }

  const logoPath = path.join(iconsDir, 'logo.png');
  const svgPath = path.join(iconsDir, 'icon.svg');

  let logoSuccess = false;

  // Try logo.png first
  if (fs.existsSync(logoPath)) {
    try {
      console.log('[generate_icons] Attempting to use PNG logo...');
      const logoBuffer = fs.readFileSync(logoPath);

      // Validate with sharp metadata
      const meta = await sharp(logoBuffer).metadata();
      if (!meta || !meta.width || !meta.height) {
        throw new Error('Invalid image dimensions or metadata.');
      }

      await rasterize(logoBuffer, iconsDir);
      logoSuccess = true;
      console.log('[generate_icons] PWA icons successfully generated from logo.png.');
    } catch (err) {
      console.warn('[generate_icons] Failed to generate icons from logo.png. Reason:', err.message);
    }
  } else {
    console.log('[generate_icons] logo.png not found, will fall back to icon.svg.');
  }

  // Fallback to icon.svg if logo failed
  if (!logoSuccess) {
    if (fs.existsSync(svgPath)) {
      try {
        console.log('[generate_icons] Falling back to icon.svg...');
        const svgBuffer = fs.readFileSync(svgPath);

        // Validate with sharp metadata
        const meta = await sharp(svgBuffer).metadata();
        if (!meta || !meta.width || !meta.height) {
          throw new Error('Invalid SVG image dimensions or metadata.');
        }

        await rasterize(svgBuffer, iconsDir);
        console.log('[generate_icons] PWA icons successfully generated from fallback icon.svg.');
      } catch (err) {
        console.error('[generate_icons] CRITICAL: Failed to generate icons from fallback icon.svg as well. Reason:', err.message);
        // Note: We deliberately do NOT call process.exit(1) to avoid breaking Docker image builds.
      }
    } else {
      console.error('[generate_icons] CRITICAL: Neither logo.png nor fallback icon.svg could be found. No icons generated.');
    }
  }
}

// Support running directly from command line
if (require.main === module) {
  generateIcons();
}

module.exports = { generateIcons };
