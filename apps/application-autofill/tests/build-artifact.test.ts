import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../dist/manifest.json", import.meta.url), "utf8")) as {
  version: string;
  content_scripts: Array<{ js: string[] }>;
};
const packageVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

test("every manifest content script parses as a classic script", () => {
  assert.equal(manifest.version, packageVersion);
  for (const entry of manifest.content_scripts) {
    for (const fileName of entry.js) {
      const source = readFileSync(resolve(dist, fileName), "utf8");
      assert.doesNotThrow(() => new Script(source, { filename: fileName }));
    }
  }
});
