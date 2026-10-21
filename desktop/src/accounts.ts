import type { Account } from "./types";

/** Account types: budget accounts, then tracking assets and liabilities. The type sets the kind. */
export const ACCOUNT_TYPES: { group: string; kind: Account["kind"]; types: [string, string][] }[] = [
  {
    group: "Budget accounts",
    kind: "cash",
    types: [
      ["checking", "Checking"],
      ["savings", "Savings"],
      ["cash", "Cash"],
    ],
  },
  {
    group: "Budget accounts",
    kind: "credit",
    types: [
      ["creditCard", "Credit card"],
      ["lineOfCredit", "Line of credit"],
    ],
  },
  {
    group: "Tracking assets",
    kind: "tracking",
    types: [
      ["investment", "Investment"],
      ["retirement", "Retirement"],
      ["property", "Property"],
      ["vehicle", "Vehicle"],
      ["receivable", "Receivable (money owed to you)"],
      ["otherAsset", "Other asset"],
    ],
  },
  {
    group: "Tracking liabilities",
    kind: "tracking",
    types: [
      ["mortgage", "Mortgage"],
      ["autoLoan", "Auto loan"],
      ["studentLoan", "Student loan"],
      ["personalLoan", "Personal loan"],
      ["medicalDebt", "Medical debt"],
      ["otherDebt", "Other debt"],
    ],
  },
];
const LIABILITIES = new Set(["creditCard", "lineOfCredit", "mortgage", "autoLoan", "studentLoan", "personalLoan", "medicalDebt", "otherDebt"]);
/** Balance-sheet headings for each type. */
const SECTIONS: Record<string, string> = {
  checking: "Cash and bank",
  savings: "Cash and bank",
  cash: "Cash and bank",
  investment: "Investments",
  retirement: "Investments",
  property: "Property",
  vehicle: "Vehicles",
  receivable: "Receivables",
  otherAsset: "Other assets",
  creditCard: "Credit cards",
  lineOfCredit: "Lines of credit",
  mortgage: "Mortgages",
  autoLoan: "Loans",
  studentLoan: "Loans",
  personalLoan: "Loans",
  medicalDebt: "Other debts",
  otherDebt: "Other debts",
};
export const kindForType = (type: string): Account["kind"] =>
  ACCOUNT_TYPES.find((g) => g.types.some(([t]) => t === type))?.kind ?? "tracking";
export const typeName = (type: string) =>
  ACCOUNT_TYPES.flatMap((g) => g.types).find(([t]) => t === type)?.[1] ?? type;
export const isLiability = (type: string) => LIABILITIES.has(type);
/** Debts tracked outside the budget (mortgages, loans): the types with loan details and a payoff planner. */
export const isLoanType = (type: string) => isLiability(type) && kindForType(type) === "tracking";
export const sectionOf = (type: string) => SECTIONS[type] ?? (isLiability(type) ? "Other debts" : "Other assets");

/**
 * An account's type: the one chosen, else YNAB's imported type, else a guess from its kind
 * (tracking accounts by the sign of `balance`).
 */
export function accountType(a: Account, balance = a.openingBalance): string {
  if (a.accountType && SECTIONS[a.accountType]) return a.accountType;
  const imported = typeof a.source?.type === "string" ? a.source.type : "";
  if (imported === "otherLiability") return "otherDebt";
  if (SECTIONS[imported]) return imported;
  if (a.kind === "credit") return "creditCard";
  if (a.kind === "cash") return "checking";
  return balance < 0 ? "otherDebt" : "otherAsset";
}
/** Whether the account's balance counts toward net worth (tracking accounts can opt out). */
export const inNetWorth = (a: Account) => a.netWorth !== false;
