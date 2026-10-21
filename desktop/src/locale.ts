// A new budget's currency, number and date format, guessed from the system's language and region,
// so a first launch in the US shows dollars and 10/15/2026, and in Germany euros and 15/10/2026.
import { currencySymbol, defaultNumberFormat, type DateFormat, type NumberFormat } from "./format";

/** The currency of each region, for the regions whose currency has cents. Others fall back to USD. */
const REGION_CURRENCY: Record<string, string> = {
  US: "USD", PR: "USD", EC: "USD", SV: "USD", PA: "USD",
  CA: "CAD", AU: "AUD", NZ: "NZD", GB: "GBP", IE: "EUR", CH: "CHF", LI: "CHF",
  AT: "EUR", BE: "EUR", BG: "EUR", HR: "EUR", CY: "EUR", EE: "EUR", FI: "EUR", FR: "EUR", DE: "EUR",
  GR: "EUR", IT: "EUR", LV: "EUR", LT: "EUR", LU: "EUR", MT: "EUR", NL: "EUR", PT: "EUR", SK: "EUR",
  SI: "EUR", ES: "EUR", MC: "EUR", AD: "EUR", SM: "EUR",
  SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN", CZ: "CZK", HU: "HUF", RO: "RON", RS: "RSD", UA: "UAH",
  TR: "TRY", IL: "ILS", ZA: "ZAR", NG: "NGN", KE: "KES", GH: "GHS", EG: "EGP", MA: "MAD",
  SA: "SAR", AE: "AED", QA: "QAR",
  IN: "INR", PK: "PKR", BD: "BDT", LK: "LKR", NP: "NPR", SG: "SGD", HK: "HKD", MY: "MYR", PH: "PHP",
  TH: "THB", CN: "CNY", TW: "TWD", ID: "IDR",
  MX: "MXN", BR: "BRL", AR: "ARS", CO: "COP", PE: "PEN", DO: "DOP", CR: "CRC", GT: "GTQ", UY: "UYU",
};

/** The first region the user's languages name (or imply: "de" means Germany), if any. */
function regionOf(languages: readonly string[]) {
  for (const tag of languages) {
    try {
      const region = new Intl.Locale(tag).maximize().region;
      if (region) return { tag, region };
    } catch {
      /* not a language tag */
    }
  }
  return null;
}

const centsOf = (currency: string) => {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits;
  } catch {
    return -1;
  }
};

/** Year, month and day in the order the locale writes a short date. */
function dateFormatOf(locale: string): DateFormat {
  try {
    const order = new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(2026, 9, 15))
      .map((p) => p.type)
      .filter((t) => t === "year" || t === "month" || t === "day");
    if (order[0] === "year") return "iso";
    return order.indexOf("month") < order.indexOf("day") ? "mdy" : "dmy";
  } catch {
    return "iso";
  }
}

/** The locale's decimal mark and digit grouping, when the app can show them; the default otherwise. */
function separatorsOf(locale: string): Pick<NumberFormat, "decimal" | "group"> {
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(1234567.5);
    const decimal = parts.find((p) => p.type === "decimal")?.value;
    const raw = parts.find((p) => p.type === "group")?.value ?? "";
    const group = /^\s$/.test(raw) ? " " : raw === "’" ? "'" : raw;
    if ((decimal === "." || decimal === ",") && [",", ".", " ", "'", ""].includes(group) && group !== decimal)
      return { decimal, group: group as NumberFormat["group"] };
  } catch {
    /* fall through */
  }
  return { decimal: defaultNumberFormat.decimal, group: defaultNumberFormat.group };
}

/** Whether the locale writes this currency's sign before the amount ($1.00) or after (1,00 €). */
function symbolOf(locale: string, currency: string): NumberFormat["symbol"] {
  // A code rather than a sign always goes after the amount (1.00 SAR), as `defaultSymbol` does.
  if (currencySymbol(currency) === currency) return "after";
  try {
    const types = new Intl.NumberFormat(locale, { style: "currency", currency, currencyDisplay: "narrowSymbol" })
      .formatToParts(1)
      .map((p) => p.type);
    return types.indexOf("currency") > types.indexOf("integer") ? "after" : "before";
  } catch {
    return "before";
  }
}

export type LocaleDefaults = { currency: string; numberFormat: NumberFormat; dateFormat: DateFormat };

/** A new budget's display settings for someone whose system uses these languages (most preferred first). */
export function localeDefaults(languages: readonly string[] = systemLanguages()): LocaleDefaults {
  const found = regionOf(languages);
  const locale = found?.tag ?? "en-US";
  const guess = found ? REGION_CURRENCY[found.region] : undefined;
  const currency = guess && centsOf(guess) === 2 ? guess : "USD";
  return {
    currency,
    numberFormat: { ...separatorsOf(locale), symbol: symbolOf(locale, currency) },
    dateFormat: dateFormatOf(locale),
  };
}

function systemLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
}
