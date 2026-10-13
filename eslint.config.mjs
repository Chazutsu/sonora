import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

// 0.4.2 ships a misspelled core-rule override. Remove only that invalid entry
// until the upstream preset is corrected; all other recommended config remains.
const recommendedConfig = obsidianmd.configs.recommended.map((config) => ({
	...config,
	rules: Object.fromEntries(
		Object.entries(config.rules ?? {}).filter(([rule]) => rule !== "no-prototype-bultins"),
	),
}));

const recommendedRules = Object.assign(
	{},
	...recommendedConfig.map((config) => config.rules ?? {}),
);

const advisoryRules = Object.fromEntries(
	Object.keys(recommendedRules).map((rule) => [rule, "warn"]),
);

export default defineConfig([
	...recommendedConfig,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.*", "manifest.json"],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: [".json"],
			},
		},
	},
	{
		files: ["**/*.{ts,tsx,js,jsx}"],
		rules: {
			...advisoryRules,

			// Match the community scanner: existing convention findings are advisory,
			// while unsafe code execution and DOM injection still block CI.
			"no-eval": "error",
			"no-implied-eval": "error",
			"no-unsanitized/method": "error",
			"no-unsanitized/property": "error",
			"obsidianmd/regex-lookbehind": "error",
			"obsidianmd/no-forbidden-elements": "error",

			// TypeScript and the official scanner cover or intentionally skip these.
			"no-undef": "off",
			"@typescript-eslint/no-unsafe-member-access": "off",
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-unsafe-argument": "off",
			"@typescript-eslint/no-unsafe-call": "off",
			"@typescript-eslint/no-unsafe-return": "off",
			"@typescript-eslint/restrict-template-expressions": "off",
			"@typescript-eslint/no-base-to-string": "off",
			"import/no-unresolved": "off",
			"obsidianmd/validate-manifest": "off",
			"obsidianmd/validate-license": "off",
			"obsidianmd/commands/no-command-in-command-id": "off",
			"obsidianmd/commands/no-plugin-id-in-command-id": "off",
		},
	},
	globalIgnores([
		"main.js",
		"styles.css",
		"dist/**",
		"build/**",
		"pkg/**",
		".obsidian/**",
		"tests/**",
		"scripts/**",
		"**/*.test.*",
		"**/*.spec.*",
		"**/*.cjs",
		"**/*.mjs",
		"**/*.cts",
		"**/*.mts",
	]),
]);
