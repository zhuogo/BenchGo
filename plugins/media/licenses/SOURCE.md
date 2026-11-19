# Voice preprocessing third-party sources

BenchGo bundles the unchanged WASM embedded in `dist/rnnoise-sync.js` from
`@jitsi/rnnoise-wasm@0.2.1`, pinned in the BenchGo build dependencies.
The WASM is loaded locally; the npm package and reference repositories are not
runtime dependencies. The surrounding AudioWorklet and ABI adapter are BenchGo code.

- Package: https://www.npmjs.com/package/@jitsi/rnnoise-wasm/v/0.2.1
- Wrapper source: https://github.com/jitsi/rnnoise-wasm/tree/cb529a59a8478fe604e57986fc96afdaecfa6fb7
- The package README identifies the synchronous distribution as the RNNoise 0.2
  denoising model. Its standalone `dist/rnnoise.wasm` is the legacy 0.1 detector
  and is deliberately excluded.
- RNNoise submodule source: https://github.com/xiph/rnnoise/tree/372f7b4b76cde4ca1ec4605353dd17898a99de38
- `RNNoise.txt` is the unchanged `COPYING` from that RNNoise commit.
- WASM SHA-256: `4f513a50613de74378331237886138eab52fa2650e8b1a41eb587d932d9b8850`.

The distributed `NOISE-LICENSES.txt` includes this provenance, the package's
complete Apache-2.0 license and RNNoise's complete BSD-3-Clause copyright and license.
