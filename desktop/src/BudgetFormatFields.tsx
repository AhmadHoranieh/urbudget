import { useMemo } from "react";
import { Combobox } from "./ui";
import {
  currencyCodes,
  currencySymbol,
  dateFormats,
  defaultSymbol,
  money,
  numberFormatFor,
  type DateFormat,
  type NumberFormat,
} from "./format";
import { numberPresets } from "./newBudget";

export type FormatValue = { currency: string; numberFormat: NumberFormat; dateFormat: DateFormat };

/** Currency, number and date format fields, shared by "New budget" and Settings. */
export function BudgetFormatFields({
  value,
  onChange,
}: {
  value: FormatValue;
  onChange: (value: FormatValue) => void;
}) {
  const currencies = useMemo(() => {
    let names: Intl.DisplayNames | undefined;
    try {
      names = new Intl.DisplayNames(["en"], { type: "currency" });
    } catch {
      names = undefined;
    }
    return currencyCodes().map((code) => ({
      id: code,
      label: `${code} · ${names?.of(code) ?? code}`,
      keywords: currencySymbol(code),
    }));
  }, []);
  const number = numberFormatFor(value.currency, value.numberFormat);
  const preset = numberPresets.findIndex(
    (p) => p.format.decimal === number.decimal && p.format.group === number.group,
  );
  const example = (symbol: NumberFormat["symbol"]) =>
    money(123456, { currency: value.currency, numberFormat: { ...number, symbol } });
  return (
    <div className="form-grid">
      <label>
        Currency
        <Combobox
          label="Currency"
          options={currencies}
          value={value.currency}
          onChange={(currency) =>
            onChange({
              ...value,
              currency,
              // A symbol left where the old currency puts it moves to where the new one does.
              numberFormat:
                number.symbol === defaultSymbol(value.currency)
                  ? { ...number, symbol: defaultSymbol(currency) }
                  : number,
            })
          }
        />
      </label>
      <label>
        Number format
        <select
          value={Math.max(0, preset)}
          onChange={(e) =>
            onChange({
              ...value,
              numberFormat: { ...number, ...numberPresets[Number(e.target.value)].format },
            })
          }
        >
          {numberPresets.map((p, i) => (
            <option key={p.label} value={i}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Currency placement
        <select
          value={number.symbol}
          onChange={(e) =>
            onChange({ ...value, numberFormat: { ...number, symbol: e.target.value as NumberFormat["symbol"] } })
          }
        >
          <option value="before">Before amount ({example("before")})</option>
          <option value="after">After amount ({example("after")})</option>
          <option value="none">Don’t show ({example("none")})</option>
        </select>
      </label>
      <label>
        Date format
        <select
          value={value.dateFormat}
          onChange={(e) => onChange({ ...value, dateFormat: e.target.value as DateFormat })}
        >
          {(Object.keys(dateFormats) as DateFormat[]).map((f) => (
            <option key={f} value={f}>
              {dateFormats[f]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
