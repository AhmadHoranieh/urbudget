// Arabic. Keys are the English source strings; see docs/LOCALIZATION.md for style and glossary.
// (Assembled from per-area parts while the translation is in progress.)
import type { Catalog } from "./index";
import core from "./ar/core.json";
import shell from "./ar/shell.json";
import budget from "./ar/budget.json";
import register from "./ar/register.json";
import reports from "./ar/reports.json";
import settings from "./ar/settings.json";
import imports from "./ar/imports.json";
import assistant from "./ar/assistant.json";

export const ar: Catalog = { ...core, ...shell, ...budget, ...register, ...reports, ...settings, ...imports, ...assistant };
