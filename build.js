'use strict';

// Bundles src/main.js (+ core, rclone, wake-lock) into a single, self-contained
// main.js at the repo root. Obsidian's installer and BRAT only fetch
// manifest.json, main.js and styles.css, so main.js can't require() sibling files.
const esbuild = require('esbuild');

esbuild.buildSync({
  entryPoints: ['src/main.js'],
  outfile: 'main.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'es2020',
  external: ['obsidian', 'electron'],
});

console.log('Built main.js from src/');
