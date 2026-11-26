import { describe, expect, it } from "vitest";
import {
  type AgentTemplate,
  isToolName,
  parseAgentTemplate,
} from "./agent-template.js";

const template = {
  id: "assistant",
  name: "Helpful Assistant",
  systemPrompt: "You are a helpful assistant.",
  model: {
    providerId: "openai",
    modelId: "example-model",
  },
  tools: ["echo", "web_search"],
} satisfies AgentTemplate;

function parse(input: unknown) {
  const result = parseAgentTemplate(input);

  if (!result.ok) {
    throw new Error(`${result.path}: ${result.message}`);
  }

  return result.template;
}

function expectInvalidAt(input: unknown, path: string) {
  expect(parseAgentTemplate(input)).toMatchObject({ ok: false, path: path });
}

// A missing property is reported at its parent object, naming the property.
function expectMissing(input: unknown, parentPath: string, property: string) {
  expect(parseAgentTemplate(input)).toMatchObject({
    ok: false,
    path: parentPath,
    message: expect.stringContaining(property),
  });
}

describe("parseAgentTemplate", () => {
  it("accepts a complete template", () => {
    expect(parse(template)).toEqual(template);
  });

  it("preserves internal spaces, indentation, and line breaks", () => {
    const systemPrompt = "First  line\n\n  Indented line\n\tTabbed line";

    expect(
      parse({ ...template, systemPrompt: systemPrompt }).systemPrompt,
    ).toBe(systemPrompt);
  });

  describe.each([
    "id",
    "name",
    "systemPrompt",
    "providerId",
    "modelId",
  ] as const)("%s", (field) => {
    const isModelField = field === "providerId" || field === "modelId";
    const path = isModelField ? `/model/${field}` : `/${field}`;
    const withValue = (value: unknown) =>
      isModelField
        ? { ...template, model: { ...template.model, [field]: value } }
        : { ...template, [field]: value };

    it("trims leading and trailing whitespace", () => {
      const input = withValue(" \n\tvalue \t\n ");
      const parsed = parse(input);

      expect(isModelField ? parsed.model[field] : parsed[field]).toBe("value");
      expect(input).toEqual(withValue(" \n\tvalue \t\n "));
    });

    it.each([undefined, null, 42, false, [], {}])(
      "rejects a non-string value: %j",
      (value) => {
        expectInvalidAt(withValue(value), path);
      },
    );

    it.each(["", "   ", "\n\t\r", "\u00a0\u3000"])(
      "rejects an empty or whitespace-only string: %j",
      (value) => {
        expectInvalidAt(withValue(value), path);
      },
    );
  });

  it.each(["id", "name", "systemPrompt", "model"] as const)(
    "rejects a missing %s field",
    (field) => {
      const input: Record<string, unknown> = structuredClone(template);
      delete input[field];

      expectMissing(input, "", field);
    },
  );

  it.each(["providerId", "modelId"] as const)(
    "rejects a missing model.%s field",
    (field) => {
      const model: Record<string, unknown> = { ...template.model };
      delete model[field];

      expectMissing({ ...template, model: model }, "/model", field);
    },
  );

  it.each([undefined, null, [], "template", 42, false])(
    "rejects a non-object template: %j",
    (input) => {
      expectInvalidAt(input, "");
    },
  );

  it.each([null, [], "openai", 42, false])(
    "rejects a non-object model reference: %j",
    (model) => {
      expectInvalidAt({ ...template, model: model }, "/model");
    },
  );

  it("drops unknown fields", () => {
    const input = {
      ...template,
      temperature: 0.5,
      model: { ...template.model, apiKey: "extra" },
    };

    expect(parse(input)).toEqual(template);
  });

  describe("tools", () => {
    const withTools = (tools: unknown) => ({ ...template, tools: tools });

    it("gives no tools when the field is omitted", () => {
      const { tools: _, ...input } = template;

      expect(parse(input).tools).toEqual([]);
    });

    it("accepts an empty list", () => {
      expect(parse(withTools([])).tools).toEqual([]);
    });

    it("keeps the listed order", () => {
      expect(parse(withTools(["web_search", "echo"])).tools).toEqual([
        "web_search",
        "echo",
      ]);
    });

    it("trims surrounding whitespace without modifying the input", () => {
      const input = withTools([" echo", "web_search \n"]);
      const parsed = parse(input);

      expect(parsed.tools).toEqual(["echo", "web_search"]);
      expect(input).toEqual(withTools([" echo", "web_search \n"]));
    });

    it.each(["a", "read_file2", `a${"b".repeat(63)}`])(
      "accepts the name %j",
      (name) => {
        expect(parse(withTools([name])).tools).toEqual([name]);
      },
    );

    it.each([null, "echo", 42, false, {}])(
      "rejects a non-array value: %j",
      (tools) => {
        expectInvalidAt(withTools(tools), "/tools");
      },
    );

    it.each([
      null,
      42,
      ["echo"],
      "",
      "   ",
      "Echo",
      "1echo",
      "_echo",
      "echo-tool",
      "echo tool",
      `a${"b".repeat(64)}`,
    ])("rejects an invalid entry: %j", (entry) => {
      expectInvalidAt(withTools(["echo", entry]), "/tools/1");
    });

    it("rejects a name repeated after trimming", () => {
      expect(
        parseAgentTemplate(withTools(["echo", "web_search", " echo "])),
      ).toEqual({
        ok: false,
        path: "/tools/2",
        message: 'must not repeat tool "echo"',
      });
    });
  });
});

describe("isToolName", () => {
  it.each(["a", "echo", "read_file2", `a${"b".repeat(63)}`])(
    "accepts %j",
    (name) => {
      expect(isToolName(name)).toBe(true);
    },
  );

  it.each([
    "",
    "Echo",
    "1echo",
    "_echo",
    "echo-tool",
    "echo tool",
    `a${"b".repeat(64)}`,
  ])("rejects %j", (name) => {
    expect(isToolName(name)).toBe(false);
  });

  // The template schema accepts these because parsing trims them.
  it.each([" echo", "echo ", "echo\n", "\techo\t"])(
    "rejects surrounding whitespace: %j",
    (name) => {
      expect(isToolName(name)).toBe(false);
    },
  );
});
