# Contributing

Bug reports and pull requests are welcome.

- **Bugs:** open an issue with your OS, Obsidian and rclone versions (`rclone version`), and the lines from `backup-errors.log` in the plugin folder.
- **Code:** the source is in `src/`; `main.js` is generated from it, so run `npm run build` and commit the result together with your change (CI refuses a `main.js` that does not match the source).
- **Tests:** `npm test`. One test runs real rclone when it is installed and skips otherwise.
- **Style:** plain CommonJS JavaScript, no framework; keep the surrounding code's comment density and naming.
- **Releases** are cut by the maintainer with `npm run release` after bumping the version in `manifest.json`, `package.json` and `versions.json`.
