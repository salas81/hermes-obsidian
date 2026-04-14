import esbuild from 'esbuild';

const prod = process.argv.includes('--prod');

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  external: ['obsidian', 'electron', '@codemirror/state', '@codemirror/view', '@codemirror/language', '@codemirror/commands'],
  format: 'cjs',
  target: 'es2020',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
});
