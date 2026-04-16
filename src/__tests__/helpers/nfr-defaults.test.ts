import { describe, expect, it } from "vitest";
import { formatNFRsAsMarkdown, getNFRDefaults } from "../../helpers/nfr-defaults.ts";

describe("非機能要件デフォルト", () => {
  describe("getNFRDefaults", () => {
    it("コンテキストなしでデフォルトカテゴリを返すべき", () => {
      const defaults = getNFRDefaults();
      expect(defaults.length).toBeGreaterThanOrEqual(5);

      const ids = defaults.map((c) => c.id);
      expect(ids).toContain("reliability");
      expect(ids).toContain("error-handling");
      expect(ids).toContain("logging");
      expect(ids).toContain("security");
      expect(ids).toContain("usability");
      expect(ids).toContain("data-integrity");
    });

    it("各カテゴリに少なくとも1つの項目があるべき", () => {
      const defaults = getNFRDefaults();
      for (const cat of defaults) {
        expect(cat.defaults.length).toBeGreaterThanOrEqual(1);
        for (const item of cat.defaults) {
          expect(item.id).toBeTruthy();
          expect(item.description).toBeTruthy();
          expect(item.rationale).toBeTruthy();
        }
      }
    });

    it("個人情報を扱う場合に追加のセキュリティ項目を含むべき", () => {
      const defaults = getNFRDefaults({ handlesPersonalData: true });
      const securityCat = defaults.find((c) => c.id === "security");
      expect(securityCat).toBeDefined();
      const personalDataItem = securityCat?.defaults.find((d) => d.id === "S-2");
      expect(personalDataItem).toBeDefined();
      expect(personalDataItem?.description).toContain("個人情報");
    });

    it("外部ユーザーがいる場合に認証・認可の項目を含むべき", () => {
      const defaults = getNFRDefaults({ hasExternalUsers: true });
      const securityCat = defaults.find((c) => c.id === "security");
      expect(securityCat).toBeDefined();
      const authItem = securityCat?.defaults.find((d) => d.id === "S-3");
      expect(authItem).toBeDefined();
      expect(authItem?.description).toContain("認証");
    });

    it("内部ツールでも基本的なセキュリティ項目を含むべき", () => {
      const defaults = getNFRDefaults({ isInternalTool: true });
      const securityCat = defaults.find((c) => c.id === "security");
      expect(securityCat).toBeDefined();
      expect(securityCat?.defaults.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("formatNFRsAsMarkdown", () => {
    it("マークダウン形式でフォーマットされるべき", () => {
      const defaults = getNFRDefaults();
      const md = formatNFRsAsMarkdown(defaults);

      expect(md).toContain("## デフォルト非機能要件");
      expect(md).toContain("### 信頼性");
      expect(md).toContain("### セキュリティ");
      expect(md).toContain("- 理由:");
    });

    it("空のカテゴリリストでも見出しを生成すべき", () => {
      const md = formatNFRsAsMarkdown([]);
      expect(md).toContain("## デフォルト非機能要件");
    });
  });
});
