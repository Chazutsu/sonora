import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { collectArtifactSet, validateObsidianManifest } from "obsidian-plugin-kit/deploy";

const root = resolve(import.meta.dirname, "..");
const [manifest, versions, packageJson, styles] = await Promise.all([
  readFile(resolve(root, "manifest.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "versions.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "package.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "styles.css"), "utf8"),
]);

validateObsidianManifest({ manifest, versions, expectedId: "sonora", mobile: true });
if (!/^0\.1\.(0|[1-9]\d*)$/u.test(manifest.version)) throw new Error("Sonora releases must remain in 0.1.x");
if (packageJson.version !== manifest.version) throw new Error("package.json and manifest.json versions differ");
const globalCssPatterns = [
  /(^|\})\s*\*\s*,/u,
  /(^|\})\s*:root\s*[,\{]/u,
  /(^|\})\s*(?:html|body|button|input|select|textarea|h[1-6]|ul|ol)\s*[,\{]/u,
];
if (globalCssPatterns.some((pattern) => pattern.test(styles))) {
  throw new Error("styles.css contains selectors that can leak outside the Sonora view");
}

const artifacts = await collectArtifactSet({ source: root });
for (const [name, digest] of artifacts.digests) console.log(`${name} sha256:${digest.slice(0, 12)}`);
console.log("Issues: https://github.com/Chazutsu/sonora/issues");
console.log("Donate: https://github.com/sponsors/ryo-ebata");
