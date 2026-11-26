import type { AgentTemplate } from "../config/agent-template.js";

/**
 * Pick the template to run. With `id`, the template with that ID; without
 * it, the only template. Throws, listing every available ID, when `id`
 * matches none or when it is omitted and there is more than one template.
 */
export function selectTemplate(
  templates: readonly AgentTemplate[],
  id?: string,
): AgentTemplate {
  const ids = templates.map((template) => `"${template.id}"`).join(", ");

  if (id !== undefined) {
    const template = templates.find((candidate) => candidate.id === id);
    if (template === undefined) {
      throw new Error(`Unknown template "${id}". Available templates: ${ids}.`);
    }
    return template;
  }

  const [first, ...rest] = templates;
  if (first === undefined) {
    throw new Error("There are no agent templates to choose from.");
  }
  if (rest.length > 0) {
    throw new Error(
      `Found ${templates.length} templates. ` +
        `Choose one with --template <id>: ${ids}.`,
    );
  }
  return first;
}
