// Generates a large, realistic budget database (about 2,500 transactions over three
// years, with a YNAB-style source export) for UI and performance checks.
// Usage: node scripts/qa/make-qa-budget.mjs [data-dir]   (default: ../migration-qa, git-ignored)
// Needs Node 22.5+ (node:sqlite). Replaces any existing budget in that folder.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const defaultDir = resolve(fileURLToPath(import.meta.url), "../../../../migration-qa");
const out = process.argv[2] ? resolve(process.argv[2]) : defaultDir;
mkdirSync(out, { recursive: true });
const dbPath = join(out, "budget.sqlite3");
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, join(out, "recovery.json")])
  if (existsSync(f)) rmSync(f);

let seed = 20261015;
const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0), seed / 2 ** 32);
const pick = (a) => a[Math.floor(rand() * a.length)];
const between = (lo, hi) => Math.round(lo + rand() * (hi - lo));
const hex = (k) => Array.from({ length: k }, () => Math.floor(rand() * 16).toString(16)).join("");
const uuid = () => [8, 4, 4, 4, 12].map(hex).join("-");
const pad = (n) => String(n).padStart(2, "0");

const START = { y: 2023, m: 11 };
const MONTHS = 36; // 2023-11 .. 2026-10
const TODAY = "2026-10-15";
const months = Array.from({ length: MONTHS }, (_, i) => {
  const d = new Date(START.y, START.m - 1 + i, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
});
const daysIn = (month) => new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate();
const dateIn = (month, lo = 1, hi = daysIn(month)) => `${month}-${pad(between(lo, Math.min(hi, daysIn(month))))}`;

// ---------- accounts ----------
const acct = (name, kind, openingBalance, archived = false) => {
  const id = uuid();
  return {
    id, name, kind, openingBalance, archived,
    onBudget: kind !== "tracking",
    note: null,
    source: {
      id, name, type: kind === "credit" ? "creditCard" : kind === "tracking" ? (openingBalance < 0 ? "otherLiability" : "otherAsset") : "checking",
      on_budget: kind !== "tracking", closed: archived, note: null,
      balance: openingBalance * 10, cleared_balance: openingBalance * 10, uncleared_balance: 0,
      transfer_payee_id: uuid(), direct_import_linked: false, direct_import_in_error: false,
      last_reconciled_at: "2026-08-31T21:00:00.000Z", debt_original_balance: null,
      debt_interest_rates: {}, debt_minimum_payments: {}, debt_escrow_amounts: {}, deleted: false,
    },
  };
};
const A = {
  checking: acct("Al Rajhi Current", "cash", 2_500_000),
  savings: acct("Savings Account", "cash", 5_000_000),
  wallet: acct("Cash wallet", "cash", 50_000),
  visa: acct("Visa Signature", "credit", -120_000),
  amex: acct("Amex Gold", "credit", 0),
  car: acct("Car loan", "tracking", -6_500_000),
  brokerage: acct("Brokerage", "tracking", 3_000_000),
  old: acct("Old checking", "cash", 0, true),
};
const accounts = Object.values(A);

// ---------- categories ----------
const groupDefs = {
  Bills: [["Rent", 650_000], ["Electricity", 60_000], ["Water", 12_000], ["Internet", 38_000], ["Mobile phones", 25_000], ["Car insurance", 45_000], ["Health insurance", 30_000]],
  Everyday: [["Groceries", 450_000], ["Dining out", 150_000], ["Coffee", 20_000], ["Fuel", 45_000], ["Taxi & transport", 15_000], ["Household", 40_000], ["Pharmacy", 10_000]],
  Family: [["Kids activities", 60_000], ["School fees", 200_000], ["Clothing", 30_000], ["Housekeeper", 150_000]],
  Lifestyle: [["Entertainment", 30_000], ["Subscriptions", 12_000], ["Hobbies", 20_000], ["Gifts", 25_000], ["Fitness", 20_000], ["Personal care", 15_000]],
  Goals: [["Emergency fund", 100_000], ["Vacation", 150_000], ["New car", 100_000], ["Home furniture", 50_000], ["Education", 50_000], ["Hajj & Umrah", 50_000]],
  Annual: [["Car maintenance", 30_000], ["Iqama & visas", 20_000], ["Zakat", 60_000], ["Annual subscriptions", 10_000], ["Electronics", 40_000]],
  Debt: [["Car loan payment", 250_000]],
};
const categories = [];
const C = {};
const groupIds = {};
const cat = (name, group, target, extra = {}) => {
  const id = uuid();
  groupIds[group] ??= uuid();
  const c = {
    id, name, group, target, hidden: false, note: null, ...extra,
    source: {
      id, category_group_id: groupIds[group], category_group_name: group, name, hidden: false,
      original_category_group_id: null, note: null, budgeted: 0, activity: 0, balance: 0,
      goal_type: target ? "NEED" : null, goal_needs_whole_amount: null, goal_day: null,
      goal_cadence: target ? 1 : null, goal_cadence_frequency: target ? 1 : null,
      goal_creation_month: target ? "2023-11-01" : null, goal_target: target * 10,
      goal_target_month: null, goal_percentage_complete: null, goal_months_to_budget: null,
      goal_under_funded: null, goal_overall_funded: null, goal_overall_left: null, deleted: false,
    },
  };
  categories.push(c);
  C[name] = c;
  return c;
};
cat("Visa Signature", "Credit Card Payments", 0, { paymentAccountId: A.visa.id });
cat("Amex Gold", "Credit Card Payments", 0, { paymentAccountId: A.amex.id });
for (const [group, list] of Object.entries(groupDefs))
  for (const [name, target] of list) cat(name, group, target);
C["Rent"].note = "Paid on the 1st via SADAD. Landlord: Abu Khalid.";
C["Emergency fund"].note = "Goal: 6 months of expenses.";

// ---------- transactions ----------
const transactions = [];
const payeeIds = new Map();
const payeeId = (name) => (payeeIds.has(name) ? payeeIds.get(name) : (payeeIds.set(name, uuid()), payeeIds.get(name)));
const memos = ["", "", "", "", "", "Weekly shop", "With family", "Split with Omar", "Birthday", "Refund pending", "Paid by card", "Monthly", "Receipt in email"];
const flags = ["red", "orange", "yellow", "green", "blue", "purple"];
const statusFor = (date) => (date < "2026-09-01" ? "reconciled" : date < "2026-10-08" ? "cleared" : rand() < 0.6 ? "uncleared" : "cleared");
const sourceFor = (t, account, payee, category) => ({
  id: t.id, date: t.date, amount: t.amount * 10, memo: t.memo || null, cleared: t.status,
  approved: t.approved !== false, flag_color: t.flag ?? null, flag_name: null,
  account_id: account.id, account_name: account.name, payee_id: payeeId(payee), payee_name: payee,
  category_id: category?.id ?? null, category_name: category?.name ?? "Inflow: Ready to Assign",
  transfer_account_id: t.transferAccountId, transfer_transaction_id: t.transferAccountId ? uuid() : null,
  matched_transaction_id: null, import_id: rand() < 0.5 ? `YNAB:${t.amount * 10}:${t.date}:1` : null,
  import_payee_name: rand() < 0.5 ? payee.toUpperCase() : null, import_payee_name_original: null,
  debt_transaction_type: null, deleted: false, subtransactions: [],
});
const add = ({ month, date, account, payee, amount, category, splits, transfer, memo, day }) => {
  date ??= day ? `${month}-${pad(Math.min(day, daysIn(month)))}` : dateIn(month);
  if (date > TODAY) return;
  const recent = date >= "2026-10-01";
  const t = {
    id: uuid(), date, accountId: account.id, payee: transfer ? "" : payee, memo: memo ?? pick(memos),
    amount, status: statusFor(date),
    splits: splits ?? (transfer && !category ? [] : [{ categoryId: category?.id ?? null, amount }]),
    transferAccountId: transfer?.id ?? null, transferStatus: transfer ? statusFor(date) : null,
    flag: rand() < 0.03 ? pick(flags) : null,
    approved: recent && rand() < 0.35 ? false : true,
  };
  t.source = sourceFor(t, account, transfer ? `Transfer : ${transfer.name}` : payee, category);
  if (transfer) t.transferSource = { ...t.source, id: uuid(), account_id: transfer.id, amount: -t.amount * 10, memo: t.memo || null };
  transactions.push(t);
  return t;
};

for (const month of months) {
  add({ month, day: 27, account: A.checking, payee: "Employer Co. Payroll", amount: 2_800_000, category: null, memo: "Salary" });
  if (rand() < 0.15) add({ month, account: A.checking, payee: "Freelance client", amount: between(150_000, 600_000), category: null });
  add({ month, day: 1, account: A.checking, payee: "Abu Khalid (Landlord)", amount: -650_000, category: C["Rent"] });
  add({ month, day: between(3, 8), account: A.visa, payee: "Saudi Electricity Co.", amount: -between(30_000, 95_000), category: C["Electricity"] });
  add({ month, day: between(5, 10), account: A.checking, payee: "National Water Co.", amount: -between(8_000, 16_000), category: C["Water"] });
  add({ month, day: 12, account: A.visa, payee: "STC", amount: -38_000, category: C["Internet"] });
  add({ month, day: 14, account: A.visa, payee: "Mobily", amount: -25_000, category: C["Mobile phones"] });
  add({ month, day: 20, account: A.checking, payee: "Tawuniya", amount: -45_000, category: C["Car insurance"] });
  add({ month, day: 20, account: A.checking, payee: "Bupa Arabia", amount: -30_000, category: C["Health insurance"] });
  for (let i = 0; i < 14; i++) {
    const payee = pick(["Panda", "Danube", "Tamimi Markets", "Lulu Hypermarket", "Carrefour", "Othaim Markets", "Nesto"]);
    const account = pick([A.visa, A.visa, A.amex, A.checking]);
    if (payee === "Lulu Hypermarket" && rand() < 0.6) {
      const g = -between(15_000, 60_000), h = -between(3_000, 20_000);
      add({ month, account, payee, amount: g + h, splits: [
        { categoryId: C["Groceries"].id, amount: g, memo: "Food" },
        { categoryId: C["Household"].id, amount: h, memo: "Cleaning supplies" },
      ] });
    } else add({ month, account, payee, amount: -between(8_000, 70_000), category: C["Groceries"] });
  }
  for (let i = 0; i < 9; i++)
    add({ month, account: pick([A.visa, A.amex, A.wallet]), payee: pick(["Al Baik", "Kudu", "Shawarmer", "Herfy", "Hamburgini", "Nando's", "Section-B", "Maestro Pizza", "Jahez"]), amount: -between(2_500, 32_000), category: C["Dining out"] });
  for (let i = 0; i < 10; i++)
    add({ month, account: pick([A.amex, A.wallet]), payee: pick(["Starbucks", "Barns", "Dr.CAFE", "Half Million", "% Arabica"]), amount: -between(1_200, 3_800), category: C["Coffee"] });
  for (let i = 0; i < 4; i++)
    add({ month, account: A.visa, payee: pick(["Aldrees", "SASCO", "Petromin"]), amount: -between(8_000, 15_000), category: C["Fuel"] });
  for (let i = 0; i < 4; i++)
    add({ month, account: A.amex, payee: pick(["Uber", "Careem", "Jeeny"]), amount: -between(1_800, 9_000), category: C["Taxi & transport"] });
  for (let i = 0; i < 2; i++) add({ month, account: A.visa, payee: pick(["IKEA", "SACO", "Home Centre", "Ace Hardware"]), amount: -between(4_000, 40_000), category: C["Household"] });
  add({ month, account: A.visa, payee: pick(["Nahdi", "Al Dawaa"]), amount: -between(2_000, 15_000), category: C["Pharmacy"] });
  for (const [payee, amount] of [["Netflix", -5_600], ["Shahid VIP", -2_900], ["Spotify", -2_199], ["iCloud+", -1_299]])
    add({ month, day: between(1, 28), account: A.amex, payee, amount, category: C["Subscriptions"], memo: "Monthly" });
  for (let i = 0; i < 2; i++) add({ month, account: A.visa, payee: pick(["VOX Cinemas", "Boulevard Riyadh", "Snow City", "Sparky's"]), amount: -between(5_000, 40_000), category: C["Entertainment"] });
  add({ month, account: A.visa, payee: pick(["Centrepoint", "H&M", "Zara", "Max"]), amount: -between(8_000, 50_000), category: C["Clothing"] });
  for (let i = 0; i < 2; i++) add({ month, account: A.checking, payee: pick(["Taekwondo academy", "Swimming club", "Art workshop"]), amount: -between(15_000, 40_000), category: C["Kids activities"] });
  add({ month, day: 2, account: A.checking, payee: "Fitness Time", amount: -19_900, category: C["Fitness"] });
  add({ month, day: 28, account: A.checking, payee: "Housekeeper salary", amount: -150_000, category: C["Housekeeper"] });
  if (["2024-01", "2024-09", "2025-01", "2025-09", "2026-01", "2026-09"].includes(month))
    add({ month, day: 5, account: A.checking, payee: "International School", amount: -1_200_000, category: C["School fees"] });
  if (rand() < 0.4) add({ month, account: A.visa, payee: pick(["Jarir Bookstore", "eXtra", "Amazon.sa", "Noon"]), amount: -between(10_000, 250_000), category: C["Electronics"] });
  if (rand() < 0.35) add({ month, account: A.visa, payee: pick(["Abdul Latif Jameel Service", "Petromin Express"]), amount: -between(20_000, 120_000), category: C["Car maintenance"] });
  if (rand() < 0.5) add({ month, account: A.amex, payee: pick(["Gift shop", "Florist", "Toys R Us", "Bateel"]), amount: -between(5_000, 60_000), category: C["Gifts"] });
  if (rand() < 0.5) add({ month, account: A.wallet, payee: pick(["Barber", "Salon"]), amount: -between(3_000, 12_000), category: C["Personal care"] });
  // transfers
  add({ month, day: 27, account: A.checking, transfer: A.savings, amount: -300_000, memo: "Monthly savings" });
  add({ month, day: 15, account: A.checking, transfer: A.car, amount: -250_000, category: C["Car loan payment"], memo: "Car loan installment" });
  add({ month, day: between(2, 25), account: A.checking, transfer: A.wallet, amount: -50_000, memo: "ATM withdrawal" });
  const prev = (account) => transactions.filter((t) => t.accountId === account.id && t.date.startsWith(months[months.indexOf(month) - 1] ?? "x")).reduce((n, t) => n + t.amount, 0);
  for (const card of [A.visa, A.amex]) {
    const due = -prev(card);
    if (due > 0) add({ month, day: 25, account: A.checking, transfer: card, amount: -due, memo: "Card payment" });
  }
}
transactions.sort((a, b) => a.date.localeCompare(b.date));

// ---------- assignments: cover each month's spending, then share what is left with goals ----------
const assignments = [];
// Each month is funded from the previous month's income ("living on last month's income").
const incomeOf = (month) =>
  transactions
    .filter((t) => t.date.startsWith(month))
    .flatMap((t) => t.splits)
    .filter((s) => s.categoryId === null && s.amount > 0)
    .reduce((n, s) => n + s.amount, 0);
for (const [i, month] of months.entries()) {
  const splits = transactions.filter((t) => t.date.startsWith(month)).flatMap((t) => t.splits);
  let left = incomeOf(months[i - 1] ?? month);
  const savers = categories.filter((c) => c.group === "Goals" || c.group === "Annual");
  for (const c of categories) {
    if (c.paymentAccountId || savers.includes(c)) continue;
    const spent = -splits.filter((s) => s.categoryId === c.id).reduce((n, s) => n + s.amount, 0);
    const amount = Math.min(left, Math.max(0, Math.ceil(spent / 100) * 100));
    left -= amount;
    if (amount) assignments.push({ month, categoryId: c.id, amount });
  }
  const share = Math.floor((left * 0.8) / savers.length / 100) * 100;
  for (const c of savers) {
    const amount = Math.min(c.target, share);
    if (amount) assignments.push({ month, categoryId: c.id, amount });
  }
}

// ---------- extras ----------
const payees = [...payeeIds].map(([name, id]) => ({ id, name }));
const schedule = (payee, account, amount, category, day, frequency = "monthly") => ({
  id: uuid(), nextDate: `2026-11-${pad(day)}`, anchorDate: `2024-01-${pad(day)}`, frequency, paused: false,
  transaction: { id: uuid(), date: `2026-11-${pad(day)}`, accountId: account.id, payee, memo: "", amount, status: "uncleared", splits: [{ categoryId: category?.id ?? null, amount }], transferAccountId: null, transferStatus: null },
});
const extras = {
  payees,
  categoryOrder: categories.map((c) => c.id),
  groupOrder: ["Credit Card Payments", ...Object.keys(groupDefs)],
  schedules: [
    schedule("Employer Co. Payroll", A.checking, 2_800_000, null, 27),
    schedule("Abu Khalid (Landlord)", A.checking, -650_000, C["Rent"], 1),
    schedule("Netflix", A.amex, -5_600, C["Subscriptions"], 9),
    schedule("Fitness Time", A.checking, -19_900, C["Fitness"], 2),
  ],
  payeeRules: [
    { id: uuid(), match: "PANDA", payee: "Panda", categoryId: C["Groceries"].id },
    { id: uuid(), match: "ALDREES", payee: "Aldrees", categoryId: C["Fuel"].id },
  ],
  moneyMoves: months.slice(-6).map((month) => ({ at: `${month}-03T10:00:00.000Z`, month, description: `Assigned 0.00 → 1,500.00 to Vacation` })),
  ynabMonths: months.map((month) => ({ month: `${month}-01`, note: rand() < 0.2 ? "Ramadan month — higher groceries" : "" })),
  ynabPlanId: uuid(),
  importedAt: "2026-10-15T08:00:00.000Z",
  importCounts: { sourceTransactions: transactions.length + 200, transferPairs: 200, localTransactions: transactions.length, splits: 80 },
  importAudit: { accountChecks: 48, categoryMonthChecks: 1107, monthChecks: 27, accountDifferences: [], categoryDifferences: [], readyToAssignDifferences: [] },
  sourceExport: {
    data: {
      server_knowledge: 48211,
      budget: {
        id: uuid(), name: "Primary Budget", last_modified_on: "2026-10-15T07:59:00.000Z",
        first_month: "2023-11-01", last_month: "2026-10-01",
        date_format: { format: "YYYY-MM-DD" },
        currency_format: { iso_code: "SAR", example_format: "123,456.78", decimal_digits: 2, decimal_separator: ".", symbol_first: false, group_separator: ",", currency_symbol: "SAR", display_symbol: true },
        accounts: accounts.map((a) => a.source),
        payees: payees.map((p) => ({ id: p.id, name: p.name, transfer_account_id: null, deleted: false })),
        payee_locations: [],
        category_groups: Object.entries(groupIds).map(([name, id]) => ({ id, name, hidden: false, deleted: false })),
        categories: categories.map((c) => c.source),
        months: months.map((month) => ({
          month: `${month}-01`, note: null, income: 28_000_000, budgeted: 20_000_000, activity: -19_000_000,
          to_be_budgeted: 0, age_of_money: between(20, 60), deleted: false,
          categories: categories.map((c) => ({ ...c.source, budgeted: between(0, 5_000_000), activity: -between(0, 5_000_000), balance: between(0, 5_000_000) })),
        })),
        transactions: transactions.map((t) => ({ ...t.source })),
        subtransactions: [],
        scheduled_transactions: [],
        scheduled_subtransactions: [],
      },
    },
  },
};

// ---------- write SQLite in the app's schema ----------
const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; BEGIN;
  CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, saved_at TEXT NOT NULL, name TEXT NOT NULL, currency TEXT NOT NULL);
  CREATE TABLE accounts (id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
  CREATE TABLE categories (id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
  CREATE TABLE transactions (id TEXT PRIMARY KEY, position INTEGER NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id), transfer_account_id TEXT REFERENCES accounts(id), date TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
  CREATE INDEX transaction_account_date ON transactions(account_id, date);
  CREATE TABLE assignments (month TEXT NOT NULL, category_id TEXT NOT NULL REFERENCES categories(id), amount INTEGER NOT NULL, PRIMARY KEY(month, category_id));
  CREATE TABLE budget_extras (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL CHECK(json_valid(data)));`);
db.prepare("INSERT INTO metadata VALUES (1,1,?,?,?)").run(new Date().toISOString(), "Family budget (QA)", "SAR");
const ia = db.prepare("INSERT INTO accounts VALUES (?,?,?)");
accounts.forEach((a, i) => ia.run(a.id, i, JSON.stringify(a)));
const ic = db.prepare("INSERT INTO categories VALUES (?,?,?)");
categories.forEach((c, i) => ic.run(c.id, i, JSON.stringify(c)));
const it = db.prepare("INSERT INTO transactions VALUES (?,?,?,?,?,?)");
transactions.forEach((t, i) => it.run(t.id, i, t.accountId, t.transferAccountId, t.date, JSON.stringify(t)));
const is = db.prepare("INSERT INTO assignments VALUES (?,?,?)");
assignments.forEach((a) => is.run(a.month, a.categoryId, a.amount));
db.prepare("INSERT INTO budget_extras VALUES (1,?)").run(JSON.stringify(extras));
db.exec("PRAGMA user_version=2; COMMIT;");
db.close();

const size = JSON.stringify({ accounts, categories, transactions, assignments, ...extras }).length;
console.log(JSON.stringify({ accounts: accounts.length, categories: categories.length, transactions: transactions.length, assignments: assignments.length, budgetJsonMB: +(size / 1e6).toFixed(2), dbPath }));
