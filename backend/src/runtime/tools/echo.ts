import { Type } from "typebox";
import { defineTool } from "../tool.js";

/** Returns its text argument unchanged. Holds no state, so any agent can share it. */
export const echoTool = defineTool({
  name: "echo",
  description: "Return the given text unchanged.",
  parameters: Type.Object(
    { text: Type.String({ description: "The text to return." }) },
    { additionalProperties: false },
  ),
  execute: async ({ text }) => ({ content: [{ type: "text", text }] }),
});
