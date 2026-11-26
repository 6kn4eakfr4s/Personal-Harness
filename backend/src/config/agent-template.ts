import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

// A string with at least one non-whitespace character.
const nonBlankString = Type.String({ pattern: "\\S" });

// The tool naming rule: a lowercase letter, then up to 63 lowercase letters,
// digits or underscores.
const toolNameRule = "[a-z][a-z0-9_]{0,63}";
const toolNamePattern = new RegExp(`^${toolNameRule}$`);

// A tool name in a template file. Surrounding whitespace is allowed because
// parsing trims it.
const toolName = Type.String({ pattern: `^\\s*${toolNameRule}\\s*$` });

/**
 * Whether `name` follows the tool naming rule. Stricter than the template
 * schema: surrounding whitespace is rejected, since names in code are never
 * trimmed.
 */
export function isToolName(name: string): boolean {
  return toolNamePattern.test(name);
}

/** The shape of an agent template as written in a template file. */
export const agentTemplateSchema = Type.Object({
  id: nonBlankString,
  name: nonBlankString,
  systemPrompt: nonBlankString,
  model: Type.Object({
    providerId: nonBlankString,
    modelId: nonBlankString,
  }),
  /** Names of the tools this agent may use. Omitted means no tools. */
  tools: Type.Optional(Type.Array(toolName)),
});

/** A parsed agent template. Unlike the file shape, `tools` is always set. */
export type AgentTemplate = Required<Static<typeof agentTemplateSchema>>;

export type ParseAgentTemplateResult =
  | { ok: true; template: AgentTemplate }
  | { ok: false; path: string; message: string };

/**
 * Validate an unknown value as an agent template. Surrounding whitespace is
 * trimmed from every string field and tool name, a missing `tools` becomes
 * `[]`, and unknown fields are dropped. The input is not modified.
 *
 * A failure returns the first error: `path` is a JSON pointer such as
 * "/model/modelId" ("" for the root). Schema errors are TypeBox's, unchanged.
 * A tool name repeated after trimming fails at the repeat, such as "/tools/1".
 * Whether a named tool exists is not checked here.
 */
export function parseAgentTemplate(input: unknown): ParseAgentTemplateResult {
  if (!Value.Check(agentTemplateSchema, input)) {
    const [error] = Value.Errors(agentTemplateSchema, input);
    return {
      ok: false,
      path: error?.instancePath ?? "",
      message: error?.message ?? "is not a valid agent template",
    };
  }

  const tools: string[] = [];
  for (const [index, entry] of (input.tools ?? []).entries()) {
    const tool = entry.trim();
    if (tools.includes(tool)) {
      return {
        ok: false,
        path: `/tools/${index}`,
        message: `must not repeat tool "${tool}"`,
      };
    }
    tools.push(tool);
  }

  return {
    ok: true,
    template: {
      id: input.id.trim(),
      name: input.name.trim(),
      systemPrompt: input.systemPrompt.trim(),
      model: {
        providerId: input.model.providerId.trim(),
        modelId: input.model.modelId.trim(),
      },
      tools,
    },
  };
}
