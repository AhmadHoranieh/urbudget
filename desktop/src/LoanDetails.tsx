import { useState } from "react";
import { X } from "lucide-react";
import { CategoryPicker } from "./ui";
import { editableAmount, evaluateAmount, monthName } from "./format";
import { parseRate, parseRateChange, rateText } from "./Planning";
import { today, type Budget, type LoanTerms } from "./types";
import "./loans.css";

type Rates = NonNullable<LoanTerms["rateHistory"]>;
/** The loan fields as typed. */
export type LoanDraft = { rate: string; payment: string; fees: string; category: string; rateHistory: Rates };

const amountText = (cents: number) => (cents ? editableAmount(cents) : "");
export const loanDraft = (t?: LoanTerms): LoanDraft => ({
  rate: t ? rateText(t.annualRateBasisPoints) : "",
  payment: t ? amountText(t.monthlyPayment) : "",
  fees: t ? amountText(t.monthlyFees) : "",
  category: t?.categoryId ?? "",
  rateHistory: t?.rateHistory ?? [],
});
/**
 * The typed fields as loan details to save, or null for none: a blank payment (with nothing
 * else filled in) clears them. Throws a sentence when something doesn't read.
 */
export function loanTermsOf(accountId: string, d: LoanDraft): LoanTerms | null {
  const payment = d.payment.trim() ? evaluateAmount(d.payment) : 0;
  const fees = d.fees.trim() ? evaluateAmount(d.fees) : 0;
  const rate = d.rate.trim() ? parseRate(d.rate) : 0;
  if (!payment) {
    if (rate || fees || d.rateHistory.length)
      throw new Error("Enter the loan's monthly payment, or clear its other details.");
    return null;
  }
  if (payment < 0) throw new Error("Enter the monthly payment as a positive amount.");
  if (fees < 0) throw new Error("Enter the monthly fees as a positive amount.");
  return {
    accountId,
    categoryId: d.category,
    annualRateBasisPoints: rate,
    monthlyPayment: payment,
    monthlyFees: fees,
    rateHistory: d.rateHistory,
  };
}

/** Dated rates that replace the base rate from their month, for variable-rate loans. */
export function RateChanges({ value, onChange }: { value: Rates; onChange: (rates: Rates) => void }) {
  const [month, setMonth] = useState(today().slice(0, 7));
  const [rate, setRate] = useState("");
  const [error, setError] = useState("");
  const add = () => {
    try {
      if (!month) throw new Error("Choose the month the rate starts.");
      const n = parseRateChange(rate);
      onChange(
        [...value.filter((r) => r.month !== month), { month, annualRateMilliPercent: n }].sort((a, b) =>
          a.month.localeCompare(b.month),
        ),
      );
      setRate("");
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <details className="rate-changes">
      <summary>Rate changes ({value.length})</summary>
      <p className="help">For a variable rate: each one replaces the rate above from its month.</p>
      <div className="rate-change-add">
        <label>
          From
          <input aria-label="Rate change month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </label>
        <label>
          New rate (%)
          <input
            aria-label="New annual rate"
            inputMode="decimal"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              add();
            }}
          />
        </label>
        <button type="button" className="secondary" onClick={add}>
          Add rate change
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {value.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>From</th>
              <th className="num">Annual rate</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {value.map((r) => (
              <tr key={r.month}>
                <td>{monthName(r.month)}</td>
                <td className="num">{r.annualRateMilliPercent / 1000}%</td>
                <td className="row-actions">
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove the ${monthName(r.month)} rate`}
                    onClick={() => onChange(value.filter((x) => x.month !== r.month))}
                  >
                    <X size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}

/**
 * A debt account's loan details in the account form: what the payoff date, the interest left
 * and the interest added with each payment are worked out from.
 */
export function LoanDetailsFields({
  budget,
  type,
  value,
  onChange,
  imported,
  onUseImported,
  focus,
}: {
  budget: Budget;
  /** The account's type: a mortgage's fees are its escrow. */
  type: string;
  value: LoanDraft;
  onChange: (d: LoanDraft) => void;
  /** The fields were filled in from the YNAB import. */
  imported?: boolean;
  /** Fills the fields from the YNAB import's terms, when it has some to offer. */
  onUseImported?: () => void;
  /** Start in the rate field (opened from "Edit loan details"). */
  focus?: boolean;
}) {
  const set = (patch: Partial<LoanDraft>) => onChange({ ...value, ...patch });
  const fees = type === "mortgage" ? "escrow" : "fees";
  return (
    <fieldset className="loan-fields">
      <legend>Loan details</legend>
      {imported ? (
        <p className="help">Filled in from your YNAB import. Check them, then save.</p>
      ) : (
        onUseImported && (
          <p className="help">
            Your YNAB import has this loan's terms.{" "}
            <button type="button" className="link-button" onClick={onUseImported}>
              Use them
            </button>
          </p>
        )
      )}
      <div className="form-grid">
        <label>
          Interest rate (%)
          <input
            aria-label="Interest rate"
            inputMode="decimal"
            placeholder="0"
            data-autofocus={focus || undefined}
            value={value.rate}
            onChange={(e) => set({ rate: e.target.value })}
          />
        </label>
        <label>
          Monthly payment
          <input
            aria-label="Monthly payment"
            inputMode="decimal"
            placeholder="0.00"
            value={value.payment}
            onChange={(e) => set({ payment: e.target.value })}
          />
        </label>
        <label>
          Monthly {fees}
          <input
            aria-label={`Monthly ${fees}`}
            inputMode="decimal"
            placeholder="0.00"
            value={value.fees}
            onChange={(e) => set({ fees: e.target.value })}
          />
        </label>
      </div>
      <div className="field">
        <span>Payment category</span>
        <CategoryPicker
          budget={budget}
          label="Payment category"
          value={value.category || null}
          onChange={(category) => set({ category })}
          placeholder="Where the payment comes from"
        />
      </div>
      <RateChanges value={value.rateHistory} onChange={(rateHistory) => set({ rateHistory })} />
      <p className="help">
        The payment includes the {fees}. The month's interest and {fees} are added to the loan with its first
        payment each month. Leave the payment blank for no loan details.
      </p>
    </fieldset>
  );
}
