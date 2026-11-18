import { Type } from "typebox";
import { describe, expect, expectTypeOf, it } from "vitest";
import { defineTool, type RegisteredTool } from "./tool.js";
import { ToolRegistry } from "./tool-registry.js";

function testTool(name: string): RegisteredTool {
  return defineTool({
    name,
    description: `The ${name} test tool.`,
    parameters: Type.Object({}),
    execute: async () => ({ content: [] }),
  });
}

const alpha = testTool("alpha");
const beta = testTool("beta");
const gamma = testTool("gamma");

describe("ToolRegistry", () => {
  describe("construction", () => {
    it("accepts no tools", () => {
      const registry = new ToolRegistry([]);

      expect(registry.resolve([])).toEqual([]);
      expect(() => registry.resolve(["alpha"])).toThrow(
        'Unknown tools: "alpha".',
      );
    });

    it("rejects a duplicate name", () => {
      expect(() => new ToolRegistry([alpha, beta, testTool("alpha")])).toThrow(
        'Tool "alpha" is registered more than once.',
      );
    });

    it("is not affected by later changes to the given array", () => {
      const tools = [alpha, beta];
      const registry = new ToolRegistry(tools);

      tools.pop();
      tools.push(gamma);

      expect(registry.resolve(["alpha", "beta"])).toEqual([alpha, beta]);
      expect(() => registry.resolve(["gamma"])).toThrow(
        'Unknown tools: "gamma".',
      );
    });
  });

  describe("resolve", () => {
    const registry = new ToolRegistry([alpha, beta, gamma]);

    it("returns the registered objects in request order", () => {
      const [first, second] = registry.resolve(["gamma", "alpha"]);

      expect(first).toBe(gamma);
      expect(second).toBe(alpha);
    });

    it("returns a new frozen array on each call", () => {
      const first = registry.resolve(["alpha", "beta"]);
      const second = registry.resolve(["alpha", "beta"]);

      expect(Object.isFrozen(first)).toBe(true);
      expect(first).not.toBe(second);
      expect(first).toEqual(second);
    });

    it("returns a frozen empty array for no names", () => {
      const resolved = registry.resolve([]);

      expect(resolved).toEqual([]);
      expect(Object.isFrozen(resolved)).toBe(true);
    });

    it("rejects a name requested twice", () => {
      expect(() => registry.resolve(["alpha", "beta", "alpha"])).toThrow(
        'Tool "alpha" is requested more than once.',
      );
    });

    it("rejects an unknown name", () => {
      expect(() => registry.resolve(["delta"])).toThrow(
        'Unknown tools: "delta".',
      );
    });

    it("lists every unknown name in one error", () => {
      expect(() => registry.resolve(["delta", "alpha", "epsilon"])).toThrow(
        'Unknown tools: "delta", "epsilon".',
      );
    });

    it("has a readonly array of registered tools as its return type", () => {
      expectTypeOf(registry.resolve).returns.toEqualTypeOf<
        readonly RegisteredTool[]
      >();
    });
  });
});
