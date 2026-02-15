import { describe, expect, it } from "vitest";
import { daysAgo } from "../../db/helpers.ts";

describe("daysAgo", () => {
  it("0日前は現在に近い日時を返すべき", () => {
    const result = daysAgo(0);
    const diff = Math.abs(Date.now() - new Date(result).getTime());
    expect(diff).toBeLessThan(1000); // 1秒以内
  });

  it("7日前の日時を返すべき", () => {
    const result = daysAgo(7);
    const expected = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const diff = Math.abs(new Date(result).getTime() - expected);
    expect(diff).toBeLessThan(1000);
  });

  it("30日前の日時を返すべき", () => {
    const result = daysAgo(30);
    const expected = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const diff = Math.abs(new Date(result).getTime() - expected);
    expect(diff).toBeLessThan(1000);
  });

  it("ISO文字列を返すべき", () => {
    const result = daysAgo(1);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(() => new Date(result)).not.toThrow();
  });
});
