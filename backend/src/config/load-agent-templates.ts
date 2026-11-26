import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { type AgentTemplate, parseAgentTemplate } from "./agent-template.js";

export interface LoadAgentTemplatesOptions {
  /** Absolute base directory used to resolve a relative templatesDir. */
  baseDir: string;
  templatesDir: string;
}

// Read all json files in the dir.
export async function loadAgentTemplates(
  options: LoadAgentTemplatesOptions,
): Promise<AgentTemplate[]> {
  if (!isAbsolute(options.baseDir)) {
    throw new Error(
      "baseDir must be an absolute path. Provide an absolute base directory.",
    );
  }

  const directory = resolve(options.baseDir, options.templatesDir);
  let entries: Dirent[];

  // List the directory. Fails if it is missing, unreadable, or not a directory.
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `Cannot read template directory "${directory}": ${String(error)}. ` +
        "Check that the directory exists and is readable.",
    );
  }

  const filenames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  if (filenames.length === 0) {
    throw new Error(
      `No agent templates found in "${directory}". ` +
        "Add a .json template file directly inside this directory.",
    );
  }

  const templates: AgentTemplate[] = [];
  const filesById = new Map<string, string>();

  for (const filename of filenames) {
    const filePath = join(directory, filename);
    let content: string;

    // Read the file as text. Fails if it was removed or is unreadable.
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      throw new Error(
        `Cannot read template file "${filePath}": ${String(error)}. ` +
          "Check that the file exists and is readable.",
      );
    }

    let input: unknown;

    // Parse the text as JSON. The schema is checked afterwards, not here.
    try {
      input = JSON.parse(content);
    } catch {
      throw new Error(
        `Invalid JSON in template file "${filePath}". ` +
          "Fix the JSON syntax and load again.",
      );
    }

    const result = parseAgentTemplate(input);

    if (!result.ok) {
      throw new Error(
        `Invalid agent template "${filePath}" at "${result.path}": ` +
          result.message,
      );
    }

    const template = result.template;
    const existingFile = filesById.get(template.id);

    if (existingFile !== undefined) {
      throw new Error(
        `Duplicate template ID "${template.id}" in ` +
          `"${existingFile}" and "${filePath}". ` +
          "Give each template a unique ID.",
      );
    }

    filesById.set(template.id, filePath);
    templates.push(template);
  }

  return templates;
}
