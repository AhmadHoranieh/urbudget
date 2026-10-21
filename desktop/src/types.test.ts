import { describe, expect, it } from "vitest";
import { parseMoney } from "./types";
describe("exact decimal input", () => {
  it("parses cents without floating point rounding", () => {
    expect(parseMoney("1.01")).toBe(101);
    expect(parseMoney("-1,234.56")).toBe(-123456);
    expect(parseMoney("1,234,567.89")).toBe(123456789);
  });
  it("rejects precision loss, exponent syntax, and non-finite numbers", () => {
    for (const value of ["0.001", "1e5", "NaN", "Infinity", "1.2.3"])
      expect(() => parseMoney(value)).toThrow();
  });
});
