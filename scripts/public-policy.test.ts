import { expect, it } from "vitest";
import { inspectPublicText, inspectSnapshot } from "./public-policy.js";

it("rejects manuscript and local configuration paths", () => {
  expect(inspectPublicText("article/article.md", "hello")).not.toEqual([]);
  expect(inspectPublicText("local-config/providers.env", "hello")).not.toEqual([]);
  expect(inspectPublicText("docs/methodology.md", "No manuscript is published.")).toEqual([]);
});
it("rejects secrets without using any real credentials in the test", () => {
  expect(inspectPublicText("data.json", "sk-" + "x".repeat(30))).not.toEqual([]);
});
it("blocks script and network-capable replay snapshots", () => {
  expect(inspectSnapshot("<script>alert(1)</script>")).not.toEqual([]);
  expect(inspectSnapshot('<button onclick="x()">Save</button>')).not.toEqual([]);
  expect(inspectSnapshot('<img src="https://example.com/image.png">')).not.toEqual([]);
  expect(inspectSnapshot("<h1>Account</h1><button>Save</button>")).toEqual([]);
});
