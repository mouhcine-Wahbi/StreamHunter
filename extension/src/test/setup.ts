import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { resetDbConnection } from "@/local/db";
import { createFakeChrome, type FakeChrome } from "./fake-chrome";

declare global {
  // eslint-disable-next-line no-var
  var fakeChrome: FakeChrome;
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory(); // a fresh, empty database for every test
  resetDbConnection();
  globalThis.fakeChrome = createFakeChrome();
  globalThis.chrome = globalThis.fakeChrome.chrome;
  window.location.hash = "";
});

afterEach(() => cleanup());

// jsdom has no canvas: previews draw nothing in tests (and say so quietly).
HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"];
