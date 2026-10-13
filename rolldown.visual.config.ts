import { defineConfig } from "rolldown";

export default defineConfig({
	input: "tests/visual/app.tsx",
	output: { file: "tests/visual/dist/app.js", format: "esm", codeSplitting: false },
});
