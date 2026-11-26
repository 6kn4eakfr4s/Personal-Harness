import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTemplate } from "./agent-template.js";
import {
  type LoadAgentTemplatesOptions,
  loadAgentTemplates,
} from "./load-agent-templates.js";

const template = {
  id: "assistant",
  name: "Helpful Assistant",
  systemPrompt: "You are a helpful assistant.",
  model: {
    providerId: "openai",
    modelId: "example-model",
  },
  tools: [],
} satisfies AgentTemplate;

let baseDir: string;
let templatesDir: string;
let options: LoadAgentTemplatesOptions;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "load-agent-templates-"));
  templatesDir = join(baseDir, "templates");
  await mkdir(templatesDir);
  options = { baseDir: baseDir, templatesDir: "templates" };
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

async function writeTemplate(filename: string, value: unknown) {
  const filePath = join(templatesDir, filename);
  await writeFile(filePath, JSON.stringify(value), "utf8");
  return filePath;
}

describe("loadAgentTemplates", () => {
  describe("successful loading", () => {
    it("loads a template from a directory relative to baseDir", async () => {
      await writeTemplate("assistant.json", template);

      await expect(loadAgentTemplates(options)).resolves.toEqual([template]);
    });

    it("loads multiple templates in filename order", async () => {
      const first = { ...template, id: "first" };
      const second = { ...template, id: "second" };
      await writeTemplate("z.json", first);
      await writeTemplate("a.json", second);

      await expect(loadAgentTemplates(options)).resolves.toEqual([
        second,
        first,
      ]);
    });

    it("loads a template file without tools as having no tools", async () => {
      const { tools: _, ...withoutTools } = template;
      await writeTemplate("assistant.json", withoutTools);

      await expect(loadAgentTemplates(options)).resolves.toEqual([
        { ...withoutTools, tools: [] },
      ]);
    });
  });

  describe("duplicate IDs", () => {
    it.each(["assistant", " assistant "])(
      "rejects duplicate ID %j and identifies both files",
      async (id) => {
        const firstFile = await writeTemplate("a.json", template);
        const secondFile = await writeTemplate("b.json", {
          ...template,
          id: id,
        });

        await expect(loadAgentTemplates(options)).rejects.toThrow(
          `Duplicate template ID "assistant" in ` +
            `"${firstFile}" and "${secondFile}".`,
        );
      },
    );
  });

  describe("invalid paths", () => {
    it("rejects a relative baseDir", async () => {
      await expect(
        loadAgentTemplates({ baseDir: ".", templatesDir: "templates" }),
      ).rejects.toThrow("baseDir must be an absolute path");
    });

    it("rejects a directory that does not exist", async () => {
      const missingDir = join(baseDir, "missing");

      await expect(
        loadAgentTemplates({ baseDir: baseDir, templatesDir: missingDir }),
      ).rejects.toThrow(`Cannot read template directory "${missingDir}"`);
    });

    it("rejects a file used as the template directory", async () => {
      const filePath = await writeTemplate("assistant.json", template);

      await expect(
        loadAgentTemplates({ baseDir: baseDir, templatesDir: filePath }),
      ).rejects.toThrow(`Cannot read template directory "${filePath}"`);
    });
  });

  describe("no templates", () => {
    it("rejects an empty directory", async () => {
      await expect(loadAgentTemplates(options)).rejects.toThrow(
        `No agent templates found in "${templatesDir}"`,
      );
    });

    it("rejects a directory with only unrelated or nested files", async () => {
      await writeFile(join(templatesDir, "notes.txt"), "Notes", "utf8");
      await mkdir(join(templatesDir, "nested"));
      await writeTemplate("nested/assistant.json", template);

      await expect(loadAgentTemplates(options)).rejects.toThrow(
        `No agent templates found in "${templatesDir}"`,
      );
    });
  });

  describe("invalid formats", () => {
    it("rejects malformed JSON and identifies the file", async () => {
      const filePath = join(templatesDir, "invalid.json");
      await writeFile(filePath, '{"id":', "utf8");

      await expect(loadAgentTemplates(options)).rejects.toThrow(
        `Invalid JSON in template file "${filePath}"`,
      );
    });

    it.each([null, []])("rejects a non-object template: %j", async (value) => {
      const filePath = await writeTemplate("invalid.json", value);

      await expect(loadAgentTemplates(options)).rejects.toThrow(
        `Invalid agent template "${filePath}" at ""`,
      );
    });

    it("rejects a missing required field", async () => {
      const filePath = await writeTemplate("invalid.json", {
        name: template.name,
        systemPrompt: template.systemPrompt,
        model: template.model,
      });

      await expect(loadAgentTemplates(options)).rejects.toThrow(
        `Invalid agent template "${filePath}" at "": ` +
          "must have required properties id",
      );
    });

    it("rejects a field with the wrong type", async () => {
      const filePath = await writeTemplate("invalid.json", {
        ...template,
        model: { ...template.model, modelId: 42 },
      });

      await expect(loadAgentTemplates(options)).rejects.toThrow(
        `Invalid agent template "${filePath}" at "/model/modelId"`,
      );
    });
  });
});
