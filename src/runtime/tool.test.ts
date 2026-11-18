import { type Static, Type } from "typebox";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  defineTool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from "./tool.js";

function addSchema() {
  return Type.Object(
    {
      left: Type.Number(),
      right: Type.Number(),
      labels: Type.Optional(Type.Array(Type.String())),
    },
    { additionalProperties: false },
  );
}

type AddSchema = ReturnType<typeof addSchema>;

function sumResult(left: number, right: number): ToolResult {
  return { content: [{ type: "text", text: String(left + right) }] };
}

function addDefinition(
  overrides: Partial<ToolDefinition<AddSchema>> = {},
): ToolDefinition<AddSchema> {
  return {
    name: "add",
    description: "Add two numbers.",
    parameters: addSchema(),
    execute: async ({ left, right }) => sumResult(left, right),
    ...overrides,
  };
}

function context(signal = new AbortController().signal): ToolExecutionContext {
  return { agentId: "agent-1", toolCallId: "call-1", signal };
}

describe("defineTool", () => {
  describe("definition", () => {
    it("returns a frozen tool with the given fields", () => {
      const definition = addDefinition();
      const tool = defineTool(definition);

      expect(Object.isFrozen(tool)).toBe(true);
      expect(tool.name).toBe("add");
      expect(tool.description).toBe("Add two numbers.");
      expect(tool.parameters).toEqual(definition.parameters);
    });

    it.each(["", "Add", "1add", "add-numbers", " add"])(
      "rejects the name %j",
      (name) => {
        expect(() => defineTool(addDefinition({ name }))).toThrow(
          `Invalid tool name "${name}"`,
        );
      },
    );

    it.each(["", "   ", "\n\t"])("rejects the description %j", (value) => {
      expect(() => defineTool(addDefinition({ description: value }))).toThrow(
        'Tool "add" must have a non-blank description.',
      );
    });

    it("ignores later changes to the definition's fields", () => {
      const definition = addDefinition();
      const tool = defineTool(definition);

      definition.name = "renamed";
      definition.description = "Changed.";

      expect(tool.name).toBe("add");
      expect(tool.description).toBe("Add two numbers.");
    });
  });

  describe("schema ownership", () => {
    it("keeps its own copy of the schema", () => {
      const definition = addDefinition();
      const tool = defineTool(definition);

      expect(tool.parameters).not.toBe(definition.parameters);
      expect(tool.parameters.properties).not.toBe(
        definition.parameters.properties,
      );
    });

    it("is not affected by changes to the original schema", async () => {
      const definition = addDefinition();
      const tool = defineTool(definition);

      // Widen the type so the test can change the schema's shape.
      const original: {
        properties: Record<string, unknown>;
        required?: string[];
      } = definition.parameters;
      original.properties.left = Type.String();
      original.required = [];

      expect(tool.parameters.properties.left).toEqual(Type.Number());
      expect(tool.parameters.required).toEqual(["left", "right"]);
      await expect(
        tool.execute({ left: 2, right: 3 }, context()),
      ).resolves.toEqual(sumResult(2, 3));
    });

    it("freezes the schema deeply", () => {
      const { parameters } = defineTool(addDefinition());

      expect(Object.isFrozen(parameters)).toBe(true);
      expect(Object.isFrozen(parameters.properties)).toBe(true);
      expect(Object.isFrozen(parameters.properties.left)).toBe(true);
      expect(Object.isFrozen(parameters.properties.labels)).toBe(true);
      expect(Object.isFrozen(parameters.required)).toBe(true);
    });
  });

  describe("execute", () => {
    it("passes arguments and context through and returns the result", async () => {
      const result: ToolResult = { content: [{ type: "text", text: "5" }] };
      const handler = vi.fn(
        async (_args: Static<AddSchema>, _context: ToolExecutionContext) =>
          result,
      );
      const tool = defineTool(addDefinition({ execute: handler }));
      const args = { left: 2, right: 3, labels: ["a"] };
      const callContext = context();

      await expect(tool.execute(args, callContext)).resolves.toBe(result);
      expect(handler).toHaveBeenCalledExactlyOnceWith(args, callContext);
      expect(handler.mock.calls[0]?.[0]).toBe(args);
    });

    it("rejects a wrong type without converting it", async () => {
      const handler = vi.fn(async () => sumResult(0, 0));
      const tool = defineTool(addDefinition({ execute: handler }));

      await expect(
        tool.execute({ left: "2", right: 3 }, context()),
      ).rejects.toThrow('Invalid arguments for tool "add" at /left');
      expect(handler).not.toHaveBeenCalled();
    });

    it("rejects a missing property", async () => {
      const handler = vi.fn(async () => sumResult(0, 0));
      const tool = defineTool(addDefinition({ execute: handler }));

      await expect(tool.execute({ left: 2 }, context())).rejects.toThrow(
        'Invalid arguments for tool "add"',
      );
      expect(handler).not.toHaveBeenCalled();
    });

    it("rejects an extra property the schema does not allow", async () => {
      const handler = vi.fn(async () => sumResult(0, 0));
      const tool = defineTool(addDefinition({ execute: handler }));

      await expect(
        tool.execute({ left: 2, right: 3, extra: true }, context()),
      ).rejects.toThrow('Invalid arguments for tool "add" at /extra');
      expect(handler).not.toHaveBeenCalled();
    });

    it.each([undefined, null, "args", 42, []])(
      "rejects non-object arguments: %j",
      async (args) => {
        const handler = vi.fn(async () => sumResult(0, 0));
        const tool = defineTool(addDefinition({ execute: handler }));

        await expect(tool.execute(args, context())).rejects.toThrow(
          'Invalid arguments for tool "add" at /:',
        );
        expect(handler).not.toHaveBeenCalled();
      },
    );

    it("rejects with an AbortError when the signal is already aborted", async () => {
      const handler = vi.fn(async () => sumResult(0, 0));
      const tool = defineTool(addDefinition({ execute: handler }));
      const controller = new AbortController();
      controller.abort();

      await expect(
        tool.execute({ left: 2, right: 3 }, context(controller.signal)),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(handler).not.toHaveBeenCalled();
    });

    it("passes a handler error through unchanged", async () => {
      const error = new Error("disk full");
      const tool = defineTool(
        addDefinition({
          execute: async () => {
            throw error;
          },
        }),
      );

      await expect(tool.execute({ left: 2, right: 3 }, context())).rejects.toBe(
        error,
      );
    });
  });

  it("types handler arguments from the schema", () => {
    const parameters = addSchema();

    defineTool({
      name: "add",
      description: "Add two numbers.",
      parameters,
      execute: async (args, callContext) => {
        expectTypeOf(args).toEqualTypeOf<Static<AddSchema>>();
        expectTypeOf(args).toEqualTypeOf<{
          left: number;
          right: number;
          labels?: string[];
        }>();
        expectTypeOf(callContext).toEqualTypeOf<ToolExecutionContext>();
        return sumResult(args.left, args.right);
      },
    });
  });
});
