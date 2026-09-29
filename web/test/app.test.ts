import { expect, it } from "vitest";
import { appTitle } from "../src/app.js";

it("names the app", () => {
  expect(appTitle()).toBe("Porcupine");
});
