import { describe, expect, it, vi } from "vitest"
import { validateAppBundle, type BranchDeploymentBundle } from "./deploy-engine"

const bundle: BranchDeploymentBundle = {
  branch: "main",
  commitHash: "abc123",
  mainModule: "src/index.js",
  modules: {},
  assets: {},
  assetConfig: undefined,
  compatibilityDate: "2025-04-01",
}

describe("validateAppBundle", () => {
  it("validates the exact bundle before deployment", async () => {
    const validateApp = vi.fn()

    await validateAppBundle({ validateApp }, bundle)

    expect(validateApp).toHaveBeenCalledOnce()
    expect(validateApp).toHaveBeenCalledWith(bundle)
  })

  it("propagates runtime-contract failures to the deploy handler", async () => {
    const validateApp = vi.fn(() => {
      throw new Error("Your main module must export a class named App")
    })

    await expect(validateAppBundle({ validateApp }, bundle)).rejects.toThrow(
      "Your main module must export a class named App",
    )
  })

  it("fails closed when runtime validation is not configured", async () => {
    await expect(validateAppBundle({}, bundle)).rejects.toThrow(
      "App runtime validation is not configured",
    )
  })
})
