import { describe, expect, it } from "vitest";
import type { ToolExecutionContext } from "../tool.js";
import { echoTool } from "./echo.js";

function context(): ToolExecutionContext {
  return {
    agentId: "agent-1",
    toolCallId: "call-1",
    signal: new AbortController().signal,
  };
}

describe("echoTool", () => {
  it("is named echo", () => {
    expect(echoTool.name).toBe("echo");
  });

  it.each(["Hello", "", "  padded  "])("returns %j unchanged", async (text) => {
    await expect(echoTool.execute({ text }, context())).resolves.toEqual({
      content: [{ type: "text", text }],
    });
  });

  it.each([
    ["a missing text", {}],
    ["a text that is not a string", { text: 42 }],
    ["an extra property", { text: "Hello", loud: true }],
  ])("rejects %s", async (_, args) => {
    await expect(echoTool.execute(args, context())).rejects.toThrow(
      'Invalid arguments for tool "echo"',
    );
  });
});
