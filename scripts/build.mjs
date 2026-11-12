// Bundles the CLI with esbuild. No type declarations are emitted on purpose:
// TypeScript 7 has no stable programmatic API yet, and a CLI does not need .d.ts files.
// Type checking is done separately with `tsc --noEmit` (see package.json "typecheck").
import { readFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

// `import text from "./x.md?raw"` inlines the file as a string, so templates ship inside dist/cli.mjs.
const rawPlugin = {
  name: "raw",
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, "")),
      namespace: "raw",
    }));
    b.onLoad({ filter: /.*/, namespace: "raw" }, async (args) => ({
      // Always LF, so a build made on Windows (where git may check files out with CRLF) ships the same text as one made on macOS or Linux.
      contents: (await readFile(args.path, "utf8")).replaceAll("\r\n", "\n"),
      loader: "text",
    }));
  },
};

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
  // Installed dependencies stay external (npm installs them next to the CLI). Bundling CJS packages
  // such as `yaml` into an ESM file breaks at runtime ("Dynamic require ... is not supported").
  // Our own code and the ?raw templates are still inlined. Fastify is also optional and lazy.
  packages: "external",
  plugins: [rawPlugin],
  sourcemap: true,
  logLevel: "info",
});
