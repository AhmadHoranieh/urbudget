import { expect, it } from "vitest";
import { localeDefaults } from "./locale";

it("uses the region's currency, separators and date order", () => {
  expect(localeDefaults(["en-US"])).toEqual({
    currency: "USD",
    numberFormat: { decimal: ".", group: ",", symbol: "before" },
    dateFormat: "mdy",
  });
  expect(localeDefaults(["en-GB"])).toMatchObject({ currency: "GBP", dateFormat: "dmy" });
  expect(localeDefaults(["de-DE"])).toEqual({
    currency: "EUR",
    numberFormat: { decimal: ",", group: ".", symbol: "after" },
    dateFormat: "dmy",
  });
  expect(localeDefaults(["en-CA"]).currency).toBe("CAD");
  expect(localeDefaults(["sv-SE"])).toMatchObject({ currency: "SEK", dateFormat: "iso" });
});

it("takes the first language that implies a region", () => {
  expect(localeDefaults(["de"]).currency).toBe("EUR");
  expect(localeDefaults(["not a tag", "en-AU"]).currency).toBe("AUD");
});

it("falls back to US dollars for currencies without cents and when nothing is known", () => {
  expect(localeDefaults(["ja-JP"]).currency).toBe("USD");
  expect(localeDefaults([])).toMatchObject({ currency: "USD", dateFormat: "mdy" });
});

it("writes a currency code after the amount", () => {
  expect(localeDefaults(["ar-SA"]).currency).toBe("SAR");
  expect(localeDefaults(["en-SA"]).numberFormat.symbol).toBe("after");
});
