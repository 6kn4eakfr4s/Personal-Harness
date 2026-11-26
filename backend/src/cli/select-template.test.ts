import { describe, expect, it } from "vitest";
import type { AgentTemplate } from "../config/agent-template.js";
import { selectTemplate } from "./select-template.js";

function template(id: string): AgentTemplate {
  return {
    id,
    name: id,
    systemPrompt: "You are a helpful assistant.",
    model: { providerId: "faux", modelId: "faux-1" },
    tools: [],
  };
}

const assistant = template("assistant");
const coder = template("coder");
const writer = template("writer");

describe("selectTemplate", () => {
  describe("with an ID", () => {
    it("returns the template with that ID", () => {
      expect(selectTemplate([assistant, coder], "coder")).toBe(coder);
    });

    it("works when there is only one template", () => {
      expect(selectTemplate([assistant], "assistant")).toBe(assistant);
    });

    it("rejects an unknown ID and lists every available ID", () => {
      expect(() => selectTemplate([assistant, coder, writer], "nope")).toThrow(
        'Unknown template "nope". ' +
          'Available templates: "assistant", "coder", "writer".',
      );
    });

    it("matches the ID exactly", () => {
      expect(() => selectTemplate([assistant], " assistant")).toThrow(
        'Unknown template " assistant".',
      );
    });
  });

  describe("without an ID", () => {
    it("returns the only template", () => {
      expect(selectTemplate([assistant])).toBe(assistant);
    });

    it("rejects more than one template and lists every ID", () => {
      expect(() => selectTemplate([assistant, coder, writer])).toThrow(
        "Found 3 templates. Choose one with --template <id>: " +
          '"assistant", "coder", "writer".',
      );
    });

    it("rejects an empty list", () => {
      expect(() => selectTemplate([])).toThrow(
        "There are no agent templates to choose from.",
      );
    });
  });
});
