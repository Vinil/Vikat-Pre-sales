/**
 * ttf-loader.mjs — let `node --test` import .ttf and .png the way Wrangler does.
 *
 * The Worker imports font files directly, because wrangler.toml declares
 * `type = "Data"` for every .ttf and hands each import an ArrayBuffer. Node
 * has no such rule and refuses the extension outright.
 *
 * Registering the equivalent hook here is better than the alternatives:
 * a dynamic import in production code, or a stubbed fonts.js in tests, would
 * both mean the thing under test is not the thing that ships. This way
 * src/documents/fonts.js is exercised exactly as deployed.
 *
 * Loaded via `--import` from the test script.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';

/**
 * Both extensions wrangler.toml declares as Data: the fonts, and the Vikat
 * mark. The mark is artwork extracted from the brand guidelines rather than
 * letterforms retyped, so it is a file the renderer imports exactly like a
 * font, and the same hook has to cover it or the tests import a thing the
 * deployed Worker does not.
 */
const BINARY = /\.(?:ttf|png)$/;

registerHooks({
  resolve(specifier, context, next) {
    if (!BINARY.test(specifier)) return next(specifier, context);
    const url = new URL(specifier, context.parentURL).href;
    return { url, format: 'module', shortCircuit: true };
  },

  load(url, context, next) {
    if (!BINARY.test(url)) return next(url, context);

    const bytes = readFileSync(fileURLToPath(url));
    // Node caches the compiled source, not the file, so the base64 round trip
    // happens once per font per process.
    return {
      format: 'module',
      shortCircuit: true,
      source:
        `const b = Buffer.from('${bytes.toString('base64')}', 'base64');\n` +
        'export default b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);\n',
    };
  },
});
