import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { createFakeChrome, type FakeChrome } from "./fake-chrome";

declare global {
  // eslint-disable-next-line no-var
  var fakeChrome: FakeChrome;
}

beforeEach(() => {
  globalThis.fakeChrome = createFakeChrome();
  globalThis.chrome = globalThis.fakeChrome.chrome;
  window.location.hash = "";
});

afterEach(() => cleanup());
