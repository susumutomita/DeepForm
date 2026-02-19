import { describe, expect, it } from "vitest";
import { extractJsonFromLLM, repairTruncatedJson } from "../../routes/sessions/analysis.ts";

describe("extractJsonFromLLM", () => {
  it("そのままの JSON を解析できるべき", () => {
    const input = '{"prd":{"problemDefinition":"テスト"}}';
    const result = extractJsonFromLLM(input);
    expect(result).toEqual({ prd: { problemDefinition: "テスト" } });
  });

  it("前後の空白がある JSON を解析できるべき", () => {
    const input = '  \n{"key":"value"}\n  ';
    const result = extractJsonFromLLM(input);
    expect(result).toEqual({ key: "value" });
  });

  it("Markdown コードフェンス内の JSON を抽出できるべき", () => {
    const input = '```json\n{"prd":{"problemDefinition":"テスト"}}\n```';
    const result = extractJsonFromLLM(input);
    expect(result).toEqual({ prd: { problemDefinition: "テスト" } });
  });

  it("言語指定なしのコードフェンスを処理できるべき", () => {
    const input = '```\n{"key":"value"}\n```';
    const result = extractJsonFromLLM(input);
    expect(result).toEqual({ key: "value" });
  });

  it("コードフェンスの前後にテキストがあっても抽出できるべき", () => {
    const input = 'Here is the PRD:\n```json\n{"prd":{"problemDefinition":"テスト"}}\n```\nPlease review.';
    const result = extractJsonFromLLM(input);
    expect(result).toEqual({ prd: { problemDefinition: "テスト" } });
  });

  it("テキストに埋まった JSON オブジェクトを抽出できるべき", () => {
    const input = 'The result is: {"facts":[{"id":"F1"}]} end.';
    const result = extractJsonFromLLM(input);
    expect(result).toEqual({ facts: [{ id: "F1" }] });
  });

  it("無効な入力に対して null を返すべき", () => {
    expect(extractJsonFromLLM("not json at all")).toBeNull();
    expect(extractJsonFromLLM("")).toBeNull();
  });

  it("ネストされた JSON を正しく解析できるべき", () => {
    const input =
      '```json\n{"prd":{"problemDefinition":"テスト","coreFeatures":[{"name":"機能1","description":"説明"}]}}\n```';
    const result = extractJsonFromLLM(input) as Record<string, unknown>;
    expect(result).not.toBeNull();
    expect((result.prd as Record<string, unknown>).problemDefinition).toBe("テスト");
  });

  it("切り詰められたコードフェンス内 JSON を修復できるべき", () => {
    const input = '```json\n{"prd":{"problemDefinition":"テスト","metrics":[{"name":"完走率';
    const result = extractJsonFromLLM(input) as Record<string, unknown>;
    expect(result).not.toBeNull();
    expect((result.prd as Record<string, unknown>).problemDefinition).toBe("テスト");
  });

  it("閉じ括弧が欠けた JSON を修復できるべき", () => {
    const input = '{"prd":{"problemDefinition":"テスト","items":[{"id":"1"}';
    const result = extractJsonFromLLM(input) as Record<string, unknown>;
    expect(result).not.toBeNull();
    expect((result.prd as Record<string, unknown>).problemDefinition).toBe("テスト");
  });
});

describe("repairTruncatedJson", () => {
  it("閉じ括弧を補完して有効な JSON にするべき", () => {
    const input = '{"a":{"b":"c","d":[1,2';
    const result = repairTruncatedJson(input) as Record<string, unknown>;
    expect(result).not.toBeNull();
    expect((result.a as Record<string, unknown>).b).toBe("c");
  });

  it("文字列途中で切れた JSON を修復するべき", () => {
    const input = '{"key":"途中で切れたテキス';
    const result = repairTruncatedJson(input) as Record<string, unknown>;
    expect(result).not.toBeNull();
    expect((result.key as string).startsWith("途中で切れた")).toBe(true);
  });

  it("完全な JSON はそのまま返すべき", () => {
    const input = '{"a":1}';
    expect(repairTruncatedJson(input)).toEqual({ a: 1 });
  });

  it("修復不可能な入力には null を返すべき", () => {
    expect(repairTruncatedJson("not json")).toBeNull();
  });

  it("余分な閉じ括弧がある不正 JSON でもクラッシュしないべき", () => {
    const input = '{"a":1}}}}';
    // stack が空の状態で } に遭遇しても例外を投げない
    expect(() => repairTruncatedJson(input)).not.toThrow();
  });
});
