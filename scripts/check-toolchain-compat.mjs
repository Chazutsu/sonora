import { readFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const version = manifest.devDependencies?.typescript;
const major = Number(String(version ?? "").match(/\d+/u)?.[0]);

if (!Number.isInteger(major)) {
  throw new Error("TypeScript version must be explicit in devDependencies");
}
if (major >= 7) {
  throw new Error(
    "TypeScript 7 is blocked until typescript-eslint supports it. Keep TypeScript on 6.x and update the compatibility policy deliberately.",
  );
}

console.log(`toolchain compatibility passed: TypeScript ${version}`);
