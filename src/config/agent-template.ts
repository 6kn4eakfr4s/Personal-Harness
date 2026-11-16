import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

// A string with at least one non-whitespace character.
const nonBlankString = Type.String({ pattern: "\\S" });

export const agentTemplateSchema = Type.Object({
  id: nonBlankString,
  name: nonBlankString,
  systemPrompt: nonBlankString,
  model: Type.Object({
    providerId: nonBlankString,
    modelId: nonBlankString,
  }),
});

export type AgentTemplate = Static<typeof agentTemplateSchema>;

export type ParseAgentTemplateResult =
  | { ok: true; template: AgentTemplate }
  | { ok: false; path: string; message: string };

/**
 * Validate an unknown value as an agent template. Surrounding whitespace is
 * trimmed from every string field and unknown fields are dropped. A failure
 * returns TypeBox's first validation error unchanged: `path` is a JSON pointer
 * such as "/model/modelId" ("" for the root).
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
    },
  };
}
