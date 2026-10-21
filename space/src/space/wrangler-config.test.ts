import { describe, expect, it } from "vitest"
import { parseWranglerConfig, WranglerConfigError } from "./wrangler-config"

describe("parseWranglerConfig", () => {
  it("rejects D1 bindings in wrangler.json with the supported SQLite alternative", () => {
    expect(() =>
      parseWranglerConfig({
        "wrangler.json": JSON.stringify({
          main: "src/index.js",
          d1_databases: [{ binding: "DB", database_name: "app" }],
        }),
      }),
    ).toThrowError(
      new WranglerConfigError(
        "D1 bindings are not available to generated apps. Use this.ctx.storage.sql for the App's built-in SQLite database; it is also the database shown in the app database viewer.",
      ),
    )
  })

  it("rejects D1 bindings in wrangler.toml with the supported SQLite alternative", () => {
    expect(() =>
      parseWranglerConfig({
        "wrangler.toml": [
          'main = "src/index.js"',
          "",
          "[[d1_databases]]",
          'binding = "DB"',
          'database_name = "app"',
        ].join("\n"),
      }),
    ).toThrowError(
      new WranglerConfigError(
        "D1 bindings are not available to generated apps. Use this.ctx.storage.sql for the App's built-in SQLite database; it is also the database shown in the app database viewer.",
      ),
    )
  })
})
