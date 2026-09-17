import { beforeEach, expect, test, vi } from "vitest";
import en from "@/i18n/en.json";
import zh from "@/i18n/zh-CN.json";

const messages = { en, "zh-CN": zh };

function browserLanguage(language: string) {
  vi.spyOn(navigator, "language", "get").mockReturnValue(language);
}

beforeEach(() => vi.resetModules());

test.each(["en", "zh-CN"] as const)("saved %s overrides the browser language on a fresh load", async (locale) => {
  browserLanguage(locale === "en" ? "zh-CN" : "en-US");
  localStorage.setItem("nawaban.locale", locale);
  const i18n = await import("@/i18n");
  expect(i18n.t("board")).toBe(messages[locale].board);
  expect(document.documentElement.lang).toBe(locale);
});

test.each([
  ["zh-CN", "zh-CN"], ["zh-TW", "zh-CN"], ["ZH-hk", "zh-CN"],
  ["en-US", "en"], ["fr-FR", "en"],
] as const)("browser %s supplies the default %s locale without a saved preference", async (language, locale) => {
  browserLanguage(language);
  const i18n = await import("@/i18n");
  expect(i18n.t("inbox")).toBe(messages[locale].inbox);
  expect(document.documentElement.lang).toBe(locale);
});

test("an unsupported saved value falls back to the browser without becoming a locale", async () => {
  browserLanguage("zh-TW");
  localStorage.setItem("nawaban.locale", "unsupported");
  const i18n = await import("@/i18n");
  expect(i18n.t("board")).toBe(zh.board);
  expect(document.documentElement.lang).toBe("zh-CN");
});

test.each(["en", "zh-CN"] as const)("switching to %s persists across a fresh module load", async (next) => {
  browserLanguage(next === "en" ? "zh-CN" : "en-US");
  const original = await import("@/i18n");
  original.setLocale(next);
  expect(original.t("inbox")).toBe(messages[next].inbox);
  expect(localStorage.getItem("nawaban.locale")).toBe(next);
  expect(document.documentElement.lang).toBe(next);

  vi.resetModules();
  document.documentElement.lang = "und";
  const reloaded = await import("@/i18n");
  expect(reloaded).not.toBe(original);
  expect(reloaded.t("inbox")).toBe(messages[next].inbox);
  expect(document.documentElement.lang).toBe(next);
});

test("denied storage falls back to the browser and still permits language changes", async () => {
  browserLanguage("zh-CN");
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("Storage is disabled", "SecurityError");
  });
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Storage is disabled", "SecurityError");
  });
  const i18n = await import("@/i18n");
  expect(i18n.t("board")).toBe(zh.board);
  expect(() => i18n.setLocale("en")).not.toThrow();
  expect(i18n.t("board")).toBe(en.board);
  expect(document.documentElement.lang).toBe("en");
  expect(write).toHaveBeenCalledWith("nawaban.locale", "en");
});
