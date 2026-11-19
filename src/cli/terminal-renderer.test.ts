import {
  type AssistantMessage,
  type AssistantMessageEvent,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentTemplate } from "../config/agent-template.js";
import { AgentRuntime, type RunEvent } from "../runtime/agent-runtime.js";
import { ToolRegistry } from "../runtime/tool-registry.js";
import { echoTool } from "../runtime/tools/echo.js";
import { TerminalRenderer } from "./terminal-renderer.js";

/** Render `events` with a fresh renderer and return everything it wrote. */
function render(events: readonly RunEvent[]): string {
  let output = "";
  const renderer = new TerminalRenderer((text) => {
    output += text;
  });
  for (const event of events) {
    renderer.render(event);
  }
  return output;
}

const partial = fauxAssistantMessage("");

function modelEvent(event: AssistantMessageEvent): RunEvent {
  return { type: "model_event", event };
}

function textDelta(delta: string): RunEvent {
  return modelEvent({ type: "text_delta", contentIndex: 0, delta, partial });
}

function toolCallEnd(name: string, args: Record<string, string>): RunEvent {
  return modelEvent({
    type: "toolcall_end",
    contentIndex: 0,
    toolCall: fauxToolCall(name, args, { id: "call-1" }),
    partial,
  });
}

function toolResult(
  content: ToolResultMessage["content"],
  isError = false,
): RunEvent {
  return {
    type: "message_appended",
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "echo",
      content,
      isError,
      timestamp: 0,
    },
  };
}

function runEnd(
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
): RunEvent {
  return {
    type: "run_end",
    message: fauxAssistantMessage("", {
      stopReason,
      ...(errorMessage === undefined ? {} : { errorMessage }),
    }),
  };
}

describe("TerminalRenderer", () => {
  describe("text", () => {
    it("writes text deltas as they arrive", () => {
      const writes: string[] = [];
      const renderer = new TerminalRenderer((text) => writes.push(text));

      renderer.render(textDelta("Hel"));
      renderer.render(textDelta("lo"));

      expect(writes).toEqual(["Hel", "lo"]);
    });

    it("ends with a newline after a normal end", () => {
      expect(render([textDelta("Hel"), textDelta("lo"), runEnd("stop")])).toBe(
        "Hello\n",
      );
    });

    it("does not add a second newline", () => {
      expect(render([textDelta("Hello\n"), runEnd("stop")])).toBe("Hello\n");
    });

    it("writes nothing for a normal end with no text", () => {
      expect(render([runEnd("stop")])).toBe("");
    });
  });

  describe("tool calls", () => {
    it("writes one line with the name and JSON arguments", () => {
      expect(render([toolCallEnd("echo", { text: "hi" })])).toBe(
        '[tool] echo {"text":"hi"}\n',
      );
    });

    it("starts a new line when text is mid-line", () => {
      expect(
        render([
          textDelta("Let me check."),
          toolCallEnd("echo", { text: "x" }),
        ]),
      ).toBe('Let me check.\n[tool] echo {"text":"x"}\n');
    });

    it("keeps arguments with newlines on one line", () => {
      expect(render([toolCallEnd("echo", { text: "a\nb" })])).toBe(
        '[tool] echo {"text":"a\\nb"}\n',
      );
    });

    it("truncates long arguments", () => {
      const output = render([toolCallEnd("echo", { text: "x".repeat(300) })]);

      expect(output).toBe(`[tool] echo {"text":"${"x".repeat(191)}…\n`);
    });
  });

  describe("tool results", () => {
    it("writes a result line", () => {
      expect(render([toolResult([{ type: "text", text: "hi" }])])).toBe(
        "[result] hi\n",
      );
    });

    it("writes an error line for an error result", () => {
      expect(
        render([toolResult([{ type: "text", text: "Bad input." }], true)]),
      ).toBe("[error] Bad input.\n");
    });

    it("joins lines into one", () => {
      expect(
        render([toolResult([{ type: "text", text: "one\ntwo\r\nthree" }])]),
      ).toBe("[result] one two three\n");
    });

    it("shows non-text blocks as placeholders", () => {
      expect(
        render([
          toolResult([
            { type: "text", text: "See:" },
            { type: "image", data: "", mimeType: "image/png" },
          ]),
        ]),
      ).toBe("[result] See: [image]\n");
    });

    it("truncates long text", () => {
      const output = render([
        toolResult([{ type: "text", text: "y".repeat(201) }]),
      ]);

      expect(output).toBe(`[result] ${"y".repeat(200)}…\n`);
    });

    it("does not truncate text of exactly the limit", () => {
      const output = render([
        toolResult([{ type: "text", text: "y".repeat(200) }]),
      ]);

      expect(output).toBe(`[result] ${"y".repeat(200)}\n`);
    });

    it("does not split a character made of two code units", () => {
      const output = render([
        toolResult([{ type: "text", text: "😀".repeat(201) }]),
      ]);

      expect(output).toBe(`[result] ${"😀".repeat(200)}…\n`);
    });

    it("writes only the label for an empty result", () => {
      expect(render([toolResult([])])).toBe("[result]\n");
    });
  });

  describe("events not shown", () => {
    it("skips thinking and partial tool-call arguments", () => {
      expect(
        render([
          modelEvent({ type: "thinking_start", contentIndex: 0, partial }),
          modelEvent({
            type: "thinking_delta",
            contentIndex: 0,
            delta: "Hmm",
            partial,
          }),
          modelEvent({
            type: "thinking_end",
            contentIndex: 0,
            content: "Hmm",
            partial,
          }),
          modelEvent({ type: "toolcall_start", contentIndex: 0, partial }),
          modelEvent({
            type: "toolcall_delta",
            contentIndex: 0,
            delta: '{"te',
            partial,
          }),
        ]),
      ).toBe("");
    });

    it("skips user and assistant messages", () => {
      expect(
        render([
          {
            type: "message_appended",
            message: { role: "user", content: "Hi", timestamp: 0 },
          },
          { type: "message_appended", message: fauxAssistantMessage("Hello") },
        ]),
      ).toBe("");
    });
  });

  describe("the end of a run", () => {
    it("writes the error message", () => {
      expect(render([runEnd("error", "No API key.")])).toBe(
        "[error] No API key.\n",
      );
    });

    it("writes a fallback when an error has no message", () => {
      expect(render([runEnd("error")])).toBe(
        "[error] The model request failed.\n",
      );
    });

    it("writes (cancelled) for a cancel", () => {
      expect(render([runEnd("aborted")])).toBe("(cancelled)\n");
    });

    it("ends partial text before (cancelled)", () => {
      expect(render([textDelta("Hel"), runEnd("aborted")])).toBe(
        "Hel\n(cancelled)\n",
      );
    });

    it("writes a notice for a length cut-off", () => {
      expect(render([textDelta("Once upon"), runEnd("length")])).toBe(
        "Once upon\n(response cut off: length limit reached)\n",
      );
    });
  });

  it("renders a real run with an echo tool call", async () => {
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(
        [fauxText("Echoing."), fauxToolCall("echo", { text: "hi\nthere" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("It said hi."),
    ]);
    const template = {
      id: "assistant",
      name: "Assistant",
      systemPrompt: "You are a helpful assistant.",
      model: { providerId: "faux", modelId: "faux-1" },
      tools: ["echo"],
    } satisfies AgentTemplate;
    const runtime = new AgentRuntime({
      template,
      models,
      tools: new ToolRegistry([echoTool]),
    });

    const events: RunEvent[] = [];
    for await (const event of runtime.start("Echo hi")) {
      events.push(event);
    }

    expect(render(events)).toBe(
      "Echoing.\n" +
        '[tool] echo {"text":"hi\\nthere"}\n' +
        "[result] hi there\n" +
        "It said hi.\n",
    );
  });
});
