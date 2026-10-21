// The budget in the website's screenshots: the QA budget generator, retold in US dollars with
// US payees and amounts scaled to match. Writes a database into ../migration-showcase (ignored).
//   node web/scripts/screenshots/make-showcase-budget.mjs
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const generator = fileURLToPath(new URL("../../../desktop/scripts/qa/make-qa-budget.mjs", import.meta.url));
// Unassigned in October 2026 before the last step below, in cents, as the app shows it.
const UNASSIGNED = 93852;
// What each card's payment category still needs in October 2026 before that step, in cents, as
// the app shows it ("$1,994.27 more needed this month").
const CARD_NEEDS = { "Visa Signature": 199427, "Amex Gold": 37268 };
const out = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL("../../../migration-showcase", import.meta.url));
// LF line endings, so the multi-line swaps below also match a Windows checkout's CRLF copy.
const src = readFileSync(generator, "utf8").replace(/\r\n/g, "\n");
let s = src.replace(/(?<![\w.])(\d{1,3}(?:_\d{3})+)(?![\w])/g, "S($1)");
s = s.replace("let seed = 20261015;", "const S = (v) => Math.round((v * 0.3) / 100) * 100;\nlet seed = 20261015;");
const swaps = [
  ["Paid on the 1st via SADAD. Landlord: Abu Khalid.", "Paid on the 1st by bank transfer."],
  ["Abu Khalid (Landlord)", "Maple Street Rentals"],
  ["Al Rajhi Current", "Everyday Checking"],
  ["Saudi Electricity Co.", "City Power & Light"],
  ["National Water Co.", "Metro Water"],
  ['"STC"', '"FiberNet"'],
  ['"Mobily"', '"Horizon Wireless"'],
  ["Tawuniya", "Shield Auto Insurance"],
  ["Bupa Arabia", "Evergreen Health"],
  ['"Panda"', '"Trader Joe\'s"'], ['"PANDA"', '"TRADER JOE"'], ['"Danube"', '"Whole Foods"'], ['"Tamimi Markets"', '"Kroger"'],
  ["Lulu Hypermarket", "Costco"], ['"Carrefour"', '"Safeway"'], ['"Othaim Markets"', '"Aldi"'], ['"Nesto"', '"Target"'],
  ['"Al Baik"', '"Chipotle"'], ['"Kudu"', '"Shake Shack"'], ['"Shawarmer"', '"Sweetgreen"'], ['"Herfy"', '"Panera Bread"'],
  ['"Hamburgini"', '"Five Guys"'], ['"Section-B"', '"Thai Basil"'], ['"Maestro Pizza"', '"Domino\'s"'], ['"Jahez"', '"DoorDash"'],
  ['"Barns"', '"Blue Bottle"'], ['"Dr.CAFE"', '"Dunkin\'"'], ['"Half Million"', '"Peet\'s Coffee"'], ['"% Arabica"', '"Corner Café"'],
  ['"Aldrees"', '"Shell"'], ['"ALDREES"', '"SHELL"'], ['"SASCO"', '"Chevron"'],
  ["Petromin Express", "Jiffy Lube"], ['"Petromin"', '"Costco Gas"'],
  ['"Careem"', '"Lyft"'], ['"Jeeny"', '"Metro Transit"'],
  ['"SACO"', '"Home Depot"'], ['"Home Centre"', '"Wayfair"'],
  ['"Nahdi"', '"CVS Pharmacy"'], ['"Al Dawaa"', '"Walgreens"'],
  ["Shahid VIP", "Disney+"],
  ['"VOX Cinemas"', '"AMC Theatres"'], ['"Boulevard Riyadh"', '"Bowling alley"'], ['"Snow City"', '"City Zoo"'], ['"Sparky\'s"', '"Escape room"'],
  ['"Centrepoint"', '"Old Navy"'], ['"Max"', '"Gap"'],
  ["Fitness Time", "Planet Fitness"],
  ["Housekeeper salary", "Bright Start Daycare"], ["Housekeeper", "Childcare"],
  ["International School", "Oakwood Academy"],
  ['"Jarir Bookstore"', '"Best Buy"'], ['"eXtra"', '"Apple Store"'], ['"Amazon.sa"', '"Amazon"'], ['"Noon"', '"B&H Photo"'],
  ["Abdul Latif Jameel Service", "Toyota Service Center"],
  ['"Toys R Us"', '"Toy store"'], ['"Bateel"', '"Etsy"'],
  ["Iqama & visas", "Car registration"], ['"Zakat"', '"Charity"'], ["Hajj & Umrah", "Holidays"],
  ["Ramadan month — higher groceries", "Holiday month — more gifts"],
  ["Split with Omar", "Split with Sam"],
  ['iso_code: "SAR"', 'iso_code: "USD"'], ['symbol_first: false', 'symbol_first: true'], ['currency_symbol: "SAR"', 'currency_symbol: "$"'],
  ['"Family budget (QA)", "SAR"', '"Family budget", "USD"'],
  ['"../../../../migration-qa"', '"../../../../migration-showcase"'],
  // Three years of $750 payments would more than pay off a $19,500 loan; this one still owes $9,000.
  ['acct("Car loan", "tracking", -S(6_500_000))', 'acct("Car loan", "tracking", -S(12_000_000))'],
  // A tidy budget gives every dollar a job. Each month, what the goals' targets don't take goes
  // to the emergency fund instead of piling up unassigned.
  [
    `  const share = Math.floor((left * 0.8) / savers.length / 100) * 100;
  for (const c of savers) {
    const amount = Math.min(c.target, share);
    if (amount) assignments.push({ month, categoryId: c.id, amount });
  }`,
    `  const share = Math.floor(left / savers.length / 100) * 100;
  for (const c of savers) {
    const amount = Math.min(c.target, share);
    left -= amount;
    if (amount) assignments.push({ month, categoryId: c.id, amount });
  }
  const spare = Math.floor(left / 100) * 100;
  if (spare > 0) {
    const fund = assignments.find((a) => a.month === month && a.categoryId === C["Emergency fund"].id);
    if (fund) fund.amount += spare;
    else assignments.push({ month, categoryId: C["Emergency fund"].id, amount: spare });
  }`,
  ],
  // October 2026 tops every target up and covers what the cards' payments still need, from what is
  // still unassigned (as the app shows it) and, when that is not enough, from the emergency fund's
  // latest months. Anything left over goes to the emergency fund.
  [
    "// ---------- extras ----------",
    `if (${UNASSIGNED}) {
  const last = months.at(-1);
  const find = (month, c) => assignments.find((x) => x.month === month && x.categoryId === c.id);
  let left = ${UNASSIGNED};
  const assign = (c, amount) => {
    const a = find(last, c);
    if (a) a.amount += amount;
    else assignments.push({ month: last, categoryId: c.id, amount });
    left -= amount;
  };
  for (const c of categories) {
    if (c.paymentAccountId || !c.target) continue;
    const now = find(last, c)?.amount ?? 0;
    if (now < c.target) assign(c, c.target - now);
  }
  for (const [name, need] of Object.entries(${JSON.stringify(CARD_NEEDS)})) assign(C[name], need);
  for (const month of months.slice(0, -1).reverse()) {
    if (left >= 0) break;
    const fund = find(month, C["Emergency fund"]);
    const take = Math.min(fund?.amount ?? 0, -left);
    if (take) (fund.amount -= take), (left += take);
  }
  if (left < 0) throw new Error("Not enough to fund October's targets.");
  if (left > 0) assign(C["Emergency fund"], left);
}
// ---------- extras ----------`,
  ],
];
for (const [a, b] of swaps) {
  if (!s.includes(a)) throw new Error("not found: " + a);
  s = s.split(a).join(b);
}
// The QA generator resolves its default folder from its own location; this copy is given one.
const script = join(mkdtempSync(join(tmpdir(), "urbudget-showcase-")), "make.mjs");
writeFileSync(script, s);
process.argv[2] = out;
await import(pathToFileURL(script).href);
