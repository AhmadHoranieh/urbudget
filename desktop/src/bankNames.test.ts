import { describe, expect, it } from "vitest";
import { learnFromRename, normalizePayee, payeeRule, reapplied, ruleChanges, ruleFor, suggestMatch } from "./bankNames";
import type { Budget, Transaction } from "./types";

const rules = (list: [string, string, string | null][]): Budget["payeeRules"] =>
  list.map(([match, payee, categoryId], i) => ({ id: String.fromCharCode(97 + i), match, payee, categoryId }));

const budget = (over: Partial<Budget> = {}): Budget => ({
  schemaVersion: 2,
  name: "Test",
  currency: "USD",
  accounts: [
    { id: "cash", name: "Cash", kind: "cash", openingBalance: 0, archived: false },
    { id: "house", name: "House", kind: "tracking", openingBalance: 0, archived: false },
  ],
  categories: [
    { id: "food", name: "Food", group: "Living", target: 0 },
    { id: "treats", name: "Treats", group: "Living", target: 0 },
    { id: "local-uncategorized", name: "Uncategorized", group: "Needs review", target: 0 },
  ],
  transactions: [],
  assignments: [],
  ...over,
});

const imported = (
  id: string,
  text: string,
  amount: number,
  categoryId: string | null,
  over: Partial<Transaction> = {},
): Transaction => ({
  id,
  date: "2026-10-15",
  accountId: "cash",
  payee: text,
  importedPayee: text,
  memo: "",
  amount,
  status: "cleared",
  splits: [{ categoryId, amount }],
  transferAccountId: null,
  transferStatus: null,
  ...over,
});

describe("matching, as workflows.rs does it", () => {
  it("reads bank text without case or punctuation", () => {
    expect(normalizePayee("SQ *BLUE-BOTTLE  #12 ")).toBe("sq blue bottle 12");
    expect(normalizePayee("  Café ÑANDÚ ")).toBe("café ñandú");
    expect(normalizePayee("بنده — الرياض")).toBe("بنده الرياض");
    expect(normalizePayee("*** ")).toBe("");
  });

  it("picks the longest rule, matching from the start of a word", () => {
    const b = {
      payeeRules: rules([
        ["UBER", "Uber", null],
        ["uber eats", "Uber Eats", null],
        ["Amzn Mktp", "Amazon", null],
        ["   ", "Never", null],
      ]),
    };
    const id = (text: string) => payeeRule(b, text)?.id ?? null;
    expect(id("UBER *EATS PENDING")).toBe("b");
    expect(id("UBER   *TRIP HELP.UBER.COM")).toBe("a");
    expect(id("AMZN Mktp US*2K4AB")).toBe("c");
    expect(id("KUBER CAFE")).toBe(null);
    expect(id("MAMZN MKTP")).toBe(null);
    expect(id("UBEREATS")).toBe("a");
    expect(id("")).toBe(null);
  });

  it("says what running the rules again would change, like reapplyPayeeRules", () => {
    const b = budget({
      payeeRules: rules([
        ["sq blue bottle", "Blue Bottle", "food"],
        ["shop", "Corner Shop", null],
      ]),
      transactions: [
        imported("1", "SQ *BLUE BOTTLE 0042", -650, "local-uncategorized"),
        imported("2", "SQ *BLUE BOTTLE REFUND", 650, null),
        imported("3", "SQ *BLUE BOTTLE 7", -100, "treats"),
        imported("4", "SHOP 12", -100, "treats"),
        imported("5", "SOMEWHERE ELSE", -100, "treats"),
        imported("6", "SHOP 13", -100, null, { accountId: "house" }),
        imported("7", "SHOP 14", -100, null, { transferAccountId: "house" }),
      ],
    });
    expect(b.transactions.map((t) => reapplied(b, t))).toEqual([
      { payee: "Blue Bottle", categoryId: "food" },
      // An inflow with no category is in Ready to Assign, which may be on purpose.
      { payee: "Blue Bottle", categoryId: null },
      // A category already chosen stays.
      { payee: "Blue Bottle", categoryId: "treats" },
      { payee: "Corner Shop", categoryId: "treats" },
      null,
      // A tracking account gets a name but never a category; transfers are left alone.
      { payee: "Corner Shop", categoryId: null },
      null,
    ]);
    expect(ruleChanges(b)).toBe(5);
    expect(ruleChanges(b, new Set(["b"]))).toBe(2);
  });

  it("fills the payee's default for bank-file rows, but not for ones typed by hand", () => {
    const b = budget({
      payeeRules: rules([["amzn", "Amazon", null]]),
      payees: [{ id: "p", name: "Amazon", categoryId: "food" }],
    });
    expect(reapplied(b, imported("1", "AMZN Mktp US*2K4", -100, "local-uncategorized"))).toEqual({
      payee: "Amazon",
      categoryId: "food",
    });
    // Named Amazon already, with no rule needed: the default still fills the placeholder.
    expect(reapplied({ ...b, payeeRules: [] }, imported("2", "Amazon", -100, "local-uncategorized"))).toEqual({
      payee: "Amazon",
      categoryId: "food",
    });
    const typed = { ...imported("3", "Amazon", -100, "local-uncategorized"), importedPayee: undefined };
    expect(reapplied({ ...b, payeeRules: [] }, typed)).toBe(null);
  });
});

describe("learning bank names", () => {
  it("suggests the merchant's part of the bank text", () => {
    expect(suggestMatch("SQ *BLUE BOTTLE COFFEE OAKLAND CA")).toBe("blue bottle coffee");
    expect(suggestMatch("PURCHASE AUTHORIZED ON 09/14 STARBUCKS STORE 12345 SEATTLE WA")).toBe("starbucks store");
    expect(suggestMatch("AMZN Mktp US*2K4AB1")).toBe("amzn mktp us");
    expect(suggestMatch("7-ELEVEN 33452")).toBe("7 eleven");
    expect(suggestMatch("TST* DIG INN 0042")).toBe("dig inn");
    expect(suggestMatch("PAYPAL *NETFLIX")).toBe("netflix");
    // A word in the payee's own name is not a prefix.
    expect(suggestMatch("PAYPAL TRANSFER 123456", "PayPal")).toBe("paypal transfer");
    expect(suggestMatch("12345678")).toBe("12345678");
  });

  it("offers a rule only when the rules don't already give that name, and one that wins", () => {
    const b = {
      payeeRules: rules([
        ["amzn mktp us", "Amazon", null],
        ["sq", "Square", null],
      ]),
    };
    expect(ruleFor(b, "AMZN Mktp US*2K4AB", "Amazon")).toBe(null);
    // The suggestion is taken by another payee's rule, so the whole bank text is used.
    expect(ruleFor(b, "AMZN Mktp US*2K4AB", "Audible")).toEqual({
      id: "",
      match: "amzn mktp us 2k4ab",
      payee: "Audible",
      categoryId: null,
    });
    expect(ruleFor(b, "SQ *BLUE BOTTLE 0042", " Blue Bottle ")).toEqual({
      id: "",
      match: "blue bottle",
      payee: "Blue Bottle",
      categoryId: null,
    });
    expect(ruleFor(b, "  ", "Blue Bottle")).toBe(null);
  });

  it("learns from a bank-file transaction saved under a new name", () => {
    const t = imported("1", "SQ *BLUE BOTTLE 0042", -650, "food");
    const before = budget({ transactions: [t, { ...t, id: "2", importedPayee: undefined }] });
    expect(learnFromRename(before, { ...t, payee: "Blue Bottle" })?.match).toBe("blue bottle");
    // Same name, a transaction typed by hand, or a new one: nothing to learn.
    expect(learnFromRename(before, { ...t, memo: "x" })).toBe(null);
    expect(learnFromRename(before, { ...t, id: "2", payee: "Blue Bottle" })).toBe(null);
    expect(learnFromRename(before, { ...t, id: "9", payee: "Blue Bottle" })).toBe(null);
  });
});
