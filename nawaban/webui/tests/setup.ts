import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { setLocale } from "@/i18n";

beforeEach(() => {
  setLocale("zh-CN");
  localStorage.clear();
  history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
