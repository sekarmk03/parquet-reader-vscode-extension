import { build, context } from 'esbuild'

const production = process.argv.includes('--production')

/** Shared settings: hyparquet is ESM-only, the extension host needs CJS. */
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'], // provided by the runtime, must not be bundled
  sourcemap: !production,
  minify: production,
}

const extension = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
}

// Headless harness that exercises src/parquet.ts without launching VS Code.
const smoke = {
  ...common,
  entryPoints: ['src/smoke.ts'],
  outfile: 'dist/smoke.js',
  sourcemap: false,
  minify: false,
}

const targets = process.argv.includes('--smoke') ? [extension, smoke] : [extension]

if (process.argv.includes('--watch')) {
  for (const t of targets) {
    const ctx = await context(t)
    await ctx.watch()
  }
  console.log('watching...')
} else {
  for (const t of targets) await build(t)
  console.log(`build ok${production ? ' (production)' : ''}`)
}
