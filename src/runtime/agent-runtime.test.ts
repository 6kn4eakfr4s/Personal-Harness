import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  createModels,
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Message,
  type MutableModels,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTemplate } from "../config/agent-template.js";
import { AgentRuntime, type Run, type RunEvent } from "./agent-runtime.js";
import {
  defineTool,
  type RegisteredTool,
  type ToolExecutionContext,
  type ToolResult,
} from "./tool.js";
import { ToolRegistry } from "./tool-registry.js";
import { echoTool } from "./tools/echo.js";

const template = {
  id: "assistant",
  name: "Helpful Assistant",
  systemPrompt: "You are a helpful assistant.",
  model: { providerId: "faux", modelId: "faux-1" },
  tools: [],
} satisfies AgentTemplate;

const noTools = new ToolRegistry([]);

let faux: FauxProviderHandle;
let models: MutableModels;
let runtime: AgentRuntime;

beforeEach(() => {
  faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  models = createModels();
  models.setProvider(faux.provider);
  runtime = new AgentRuntime({ template, models, tools: noTools });
});

async function collect(run: Run): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of run) {
    events.push(event);
  }
  return events;
}

/** A queued response that is held back until `release` is called. */
function heldResponse(text: string) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    faux.appendResponses([
      async () => {
        resolve();
        await gate;
        return fauxAssistantMessage(text);
      },
    ]);
  });
  return { release, requested };
}

/** Role and text of each message, for comparing logs and contexts. */
function summarize(messages: readonly Message[]) {
  return messages.map((message) => {
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((block) => (block.type === "text" ? block.text : block.type))
            .join("");
    return `${message.role}: ${text}`;
  });
}

describe("AgentRuntime", () => {
  it("starts idle with an empty log", () => {
    expect(runtime.template).toBe(template);
    expect(runtime.log).toEqual([]);
    expect(runtime.isRunning).toBe(false);
  });

  describe("a run", () => {
    it("appends the user message and the final assistant message", async () => {
      faux.setResponses([fauxAssistantMessage("Hello!")]);

      const message = await runtime.start("Hi").result();

      expect(message.stopReason).toBe("stop");
      expect(summarize(runtime.log)).toEqual(["user: Hi", "assistant: Hello!"]);
      expect(runtime.log[1]).toBe(message);
      expect(runtime.isRunning).toBe(false);
    });

    it("returns before the model responds", async () => {
      const held = heldResponse("Hello!");

      const run = runtime.start("Hi");

      expect(runtime.isRunning).toBe(true);
      expect(summarize(runtime.log)).toEqual(["user: Hi"]);

      await held.requested;
      expect(runtime.isRunning).toBe(true);
      expect(summarize(runtime.log)).toEqual(["user: Hi"]);

      held.release();
      await run.result();
      expect(runtime.isRunning).toBe(false);
      expect(summarize(runtime.log)).toEqual(["user: Hi", "assistant: Hello!"]);
    });

    it("finishes even when nobody reads the run", async () => {
      faux.setResponses([fauxAssistantMessage("Hello!")]);

      runtime.start("Hi");

      await vi.waitFor(() => expect(runtime.isRunning).toBe(false));
      expect(summarize(runtime.log)).toEqual(["user: Hi", "assistant: Hello!"]);
    });

    it("reports events in order and streams the text", async () => {
      const text = "A reply that is long enough to arrive in several parts.";
      faux.setResponses([fauxAssistantMessage(text)]);

      const events = await collect(runtime.start("Hi"));

      const first = events[0];
      const beforeLast = events.at(-2);
      const last = events.at(-1);
      expect(first).toEqual({
        type: "message_appended",
        message: runtime.log[0],
      });
      expect(beforeLast).toEqual({
        type: "message_appended",
        message: runtime.log[1],
      });
      expect(last).toEqual({ type: "run_end", message: runtime.log[1] });

      const middle = events.slice(1, -2);
      expect(middle.every((event) => event.type === "model_event")).toBe(true);

      const streamed = middle
        .map((event) =>
          event.type === "model_event" && event.event.type === "text_delta"
            ? event.event.delta
            : "",
        )
        .join("");
      expect(streamed).toBe(text);
    });

    it("still delivers every event to a reader that starts late", async () => {
      faux.setResponses([fauxAssistantMessage("Hello!")]);

      const run = runtime.start("Hi");
      await run.result();
      const events = await collect(run);

      expect(events[0]?.type).toBe("message_appended");
      expect(events.at(-1)?.type).toBe("run_end");
    });
  });

  describe("context sent to the model", () => {
    function captureContexts(replies: string[]) {
      const contexts: string[][] = [];
      faux.setResponses(
        replies.map((reply) => (context: TranscriptContext) => {
          contexts.push(summarize(context.messages));
          return fauxAssistantMessage(reply);
        }),
      );
      return contexts;
    }

    it("is the system prompt followed by the log", async () => {
      const contexts = captureContexts(["Hello!"]);

      await runtime.start("Hi").result();

      expect(contexts).toEqual([
        ["system: You are a helpful assistant.", "user: Hi"],
      ]);
    });

    it("includes earlier turns", async () => {
      const contexts = captureContexts(["Hello!", "Fine."]);

      await runtime.start("Hi").result();
      await runtime.start("How are you?").result();

      expect(contexts[1]).toEqual([
        "system: You are a helpful assistant.",
        "user: Hi",
        "assistant: Hello!",
        "user: How are you?",
      ]);
      expect(summarize(runtime.log)).toEqual([
        "user: Hi",
        "assistant: Hello!",
        "user: How are you?",
        "assistant: Fine.",
      ]);
    });

    it("includes a log the runtime was resumed from", async () => {
      const earlier: Message[] = [
        { role: "user", content: "Hi", timestamp: 1 },
        fauxAssistantMessage("Hello!"),
      ];
      const resumed = new AgentRuntime({
        template,
        models,
        tools: noTools,
        log: earlier,
      });
      const contexts = captureContexts(["Fine."]);

      expect(summarize(resumed.log)).toEqual(["user: Hi", "assistant: Hello!"]);

      await resumed.start("How are you?").result();

      expect(contexts[0]).toEqual([
        "system: You are a helpful assistant.",
        "user: Hi",
        "assistant: Hello!",
        "user: How are you?",
      ]);
      expect(resumed.log).toHaveLength(4);
      // The caller's array is left as it was.
      expect(earlier).toHaveLength(2);
    });
  });

  describe("one active run", () => {
    it("rejects a new message while a run is active", async () => {
      const held = heldResponse("Hello!");
      const run = runtime.start("Hi");

      expect(() => runtime.start("Are you there?")).toThrow(
        "A run is already active.",
      );
      expect(summarize(runtime.log)).toEqual(["user: Hi"]);

      held.release();
      const message = await run.result();

      // The rejected message did not disturb the active run.
      expect(message.stopReason).toBe("stop");
      expect(summarize(runtime.log)).toEqual(["user: Hi", "assistant: Hello!"]);
      expect(faux.state.callCount).toBe(1);
    });

    it("accepts a new message as soon as the run has ended", async () => {
      faux.setResponses([
        fauxAssistantMessage("Hello!"),
        fauxAssistantMessage("Fine."),
      ]);

      for await (const event of runtime.start("Hi")) {
        if (event.type === "run_end") {
          expect(runtime.isRunning).toBe(false);
        }
      }
      const message = await runtime.start("How are you?").result();

      expect(message.stopReason).toBe("stop");
      expect(runtime.log).toHaveLength(4);
    });
  });

  describe("cancel", () => {
    it("ends the run as aborted and keeps the partial text", async () => {
      const slow = fauxProvider({ provider: "slow", tokensPerSecond: 2000 });
      models.setProvider(slow.provider);
      slow.setResponses([fauxAssistantMessage("word ".repeat(400))]);
      const slowRuntime = new AgentRuntime({
        template: {
          ...template,
          model: { providerId: "slow", modelId: slow.getModel().id },
        },
        models,
        tools: noTools,
      });

      const run = slowRuntime.start("Hi");
      let streamed = "";
      for await (const event of run) {
        if (
          event.type === "model_event" &&
          event.event.type === "text_delta" &&
          streamed === ""
        ) {
          streamed = event.event.delta;
          slowRuntime.cancel();
        }
      }
      const message = await run.result();

      expect(message.stopReason).toBe("aborted");
      expect(message.content).toEqual([{ type: "text", text: streamed }]);
      expect(slowRuntime.log).toHaveLength(2);
      expect(slowRuntime.log[1]).toBe(message);
      expect(slowRuntime.isRunning).toBe(false);
    });

    it("aborts a run cancelled before the request starts", async () => {
      faux.setResponses([fauxAssistantMessage("Hello!")]);

      const run = runtime.start("Hi");
      runtime.cancel();
      const message = await run.result();

      expect(message.stopReason).toBe("aborted");
      expect(message.content).toEqual([]);
      expect(runtime.log[1]).toBe(message);
    });

    it("allows a new run after a cancelled one", async () => {
      const held = heldResponse("Hello!");
      const run = runtime.start("Hi");
      await held.requested;
      runtime.cancel();
      held.release();
      const cancelled = await run.result();
      faux.setResponses([fauxAssistantMessage("Hello again!")]);

      const message = await runtime.start("Hi again").result();

      expect(cancelled.stopReason).toBe("aborted");
      expect(message.stopReason).toBe("stop");
      expect(runtime.log).toHaveLength(4);
    });

    it("does nothing when no run is active", async () => {
      faux.setResponses([fauxAssistantMessage("Hello!")]);

      runtime.cancel();
      const message = await runtime.start("Hi").result();

      expect(message.stopReason).toBe("stop");
    });
  });

  describe("model failures", () => {
    function expectFailure(message: AssistantMessage, errorMessage: string) {
      expect(message.stopReason).toBe("error");
      expect(message.errorMessage).toBe(errorMessage);
      expect(runtime.log).toHaveLength(2);
      expect(runtime.log[1]).toBe(message);
      expect(runtime.isRunning).toBe(false);
    }

    it("reports a model error as the stop reason", async () => {
      faux.setResponses([
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "Rate limit exceeded",
        }),
      ]);

      const events = await collect(runtime.start("Hi"));
      const last = events.at(-1);

      expect(last?.type).toBe("run_end");
      expectFailure(runtime.log[1] as AssistantMessage, "Rate limit exceeded");
    });

    it("reports an unknown model as the stop reason", async () => {
      runtime = new AgentRuntime({
        template: {
          ...template,
          model: { providerId: "faux", modelId: "missing" },
        },
        models,
        tools: noTools,
      });

      const message = await runtime.start("Hi").result();

      expectFailure(message, 'Unknown model "faux/missing".');
      expect(message.provider).toBe("faux");
      expect(message.model).toBe("missing");
      expect(faux.state.callCount).toBe(0);
    });

    it("reports an unknown provider as the stop reason", async () => {
      runtime = new AgentRuntime({
        template: {
          ...template,
          model: { providerId: "missing", modelId: "faux-1" },
        },
        models,
        tools: noTools,
      });

      const message = await runtime.start("Hi").result();

      expectFailure(message, 'Unknown model "missing/faux-1".');
    });

    it("reports a provider that throws as the stop reason", async () => {
      vi.spyOn(models, "streamSimple").mockImplementation(() => {
        throw new Error("Provider is broken");
      });

      const message = await runtime.start("Hi").result();

      expectFailure(message, "Provider is broken");
    });

    it("keeps working after a failed run", async () => {
      faux.setResponses([]);
      const failed = await runtime.start("Hi").result();
      faux.setResponses([fauxAssistantMessage("Hello!")]);

      const message = await runtime.start("Hi again").result();

      expect(failed.stopReason).toBe("error");
      expect(message.stopReason).toBe("stop");
      expect(runtime.log).toHaveLength(4);
    });
  });

  describe("tools", () => {
    function textResult(text: string): ToolResult {
      return { content: [{ type: "text", text }] };
    }

    /** An `add` tool that records each call it receives. */
    function addTool() {
      const calls: ToolExecutionContext[] = [];
      const tool = defineTool({
        name: "add",
        description: "Add two numbers.",
        parameters: Type.Object(
          { left: Type.Number(), right: Type.Number() },
          { additionalProperties: false },
        ),
        execute: async ({ left, right }, context) => {
          calls.push(context);
          return textResult(String(left + right));
        },
      });
      return { tool, calls };
    }

    /** A tool that keeps running until `release` is called. */
    function heldTool(name: string, options: { honorsSignal: boolean }) {
      const gate = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const tool = defineTool({
        name,
        description: `The ${name} test tool.`,
        parameters: Type.Object({}),
        execute: async (_, { signal }) => {
          started.resolve();
          if (options.honorsSignal) {
            await new Promise<void>((resolve, reject) => {
              void gate.promise.then(resolve);
              signal.addEventListener("abort", () => reject(signal.reason));
            });
          } else {
            await gate.promise;
          }
          return textResult(`${name} done`);
        },
      });
      return { tool, started: started.promise, release: gate.resolve };
    }

    /** A runtime whose template names `names`, from a registry of `tools`. */
    function toolRuntime(
      tools: readonly RegisteredTool[],
      names = tools.map((tool) => tool.name),
    ) {
      return new AgentRuntime({
        template: { ...template, tools: names },
        models,
        tools: new ToolRegistry(tools),
      });
    }

    function toolUse(...calls: ToolCall[]) {
      return fauxAssistantMessage(calls, { stopReason: "toolUse" });
    }

    describe("construction", () => {
      it("rejects a template that names a missing tool", () => {
        expect(() => toolRuntime([echoTool], ["echo", "search"])).toThrow(
          'Agent template "assistant": Unknown tools: "search".',
        );
      });

      it("gives each runtime its own id", () => {
        const other = new AgentRuntime({ template, models, tools: noTools });

        expect(runtime.id).toEqual(expect.any(String));
        expect(other.id).not.toBe(runtime.id);
      });

      it("sends only the name, description and parameters of its tools", async () => {
        const spy = vi.spyOn(models, "streamSimple");
        const toolRunner = toolRuntime([echoTool, addTool().tool], ["echo"]);
        faux.setResponses([fauxAssistantMessage("Hello!")]);

        await toolRunner.start("Hi").result();

        expect(spy.mock.calls[0]?.[1].tools).toEqual([
          {
            name: echoTool.name,
            description: echoTool.description,
            parameters: echoTool.parameters,
          },
        ]);
      });

      it("sends no tools for a template without any", async () => {
        const spy = vi.spyOn(models, "streamSimple");
        faux.setResponses([fauxAssistantMessage("Hello!")]);

        await runtime.start("Hi").result();

        expect(spy.mock.calls[0]?.[1]).not.toHaveProperty("tools");
      });
    });

    describe("the tool loop", () => {
      it("runs a tool call and sends its result back to the model", async () => {
        const toolRunner = toolRuntime([addTool().tool]);
        const contexts: string[][] = [];
        faux.setResponses([
          toolUse(fauxToolCall("add", { left: 2, right: 3 }, { id: "call-1" })),
          (context: TranscriptContext) => {
            contexts.push(summarize(context.messages));
            return fauxAssistantMessage("It is 5.");
          },
        ]);

        const message = await toolRunner.start("What is 2 + 3?").result();

        expect(message.stopReason).toBe("stop");
        expect(summarize(toolRunner.log)).toEqual([
          "user: What is 2 + 3?",
          "assistant: toolCall",
          "toolResult: 5",
          "assistant: It is 5.",
        ]);
        expect(toolRunner.log[2]).toMatchObject({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "add",
          isError: false,
        });
        expect(contexts[0]?.at(-1)).toBe("toolResult: 5");
      });

      it("runs several calls in order, one at a time", async () => {
        const steps: string[] = [];
        const stepTool = defineTool({
          name: "step",
          description: "Record a step.",
          parameters: Type.Object({ n: Type.Number() }),
          execute: async ({ n }) => {
            steps.push(`start ${n}`);
            await new Promise((resolve) => setTimeout(resolve, 1));
            steps.push(`end ${n}`);
            return textResult(String(n));
          },
        });
        const toolRunner = toolRuntime([stepTool]);
        faux.setResponses([
          toolUse(
            fauxToolCall("step", { n: 1 }),
            fauxToolCall("step", { n: 2 }),
          ),
          fauxAssistantMessage("Done."),
        ]);

        await toolRunner.start("Go").result();

        expect(steps).toEqual(["start 1", "end 1", "start 2", "end 2"]);
        expect(summarize(toolRunner.log).slice(2, 4)).toEqual([
          "toolResult: 1",
          "toolResult: 2",
        ]);
      });

      it("passes each call its own context", async () => {
        const add = addTool();
        const toolRunner = toolRuntime([add.tool]);
        faux.setResponses([
          toolUse(
            fauxToolCall("add", { left: 1, right: 1 }, { id: "call-1" }),
            fauxToolCall("add", { left: 2, right: 2 }, { id: "call-2" }),
          ),
          fauxAssistantMessage("Done."),
        ]);

        await toolRunner.start("Go").result();

        const [first, second] = add.calls;
        expect(first).toMatchObject({
          agentId: toolRunner.id,
          toolCallId: "call-1",
        });
        expect(second).toMatchObject({
          agentId: toolRunner.id,
          toolCallId: "call-2",
        });
        expect(first).not.toBe(second);
        expect(first?.signal).toBe(second?.signal);
        expect(first?.signal.aborted).toBe(false);
      });

      it("reports every appended message as an event", async () => {
        const toolRunner = toolRuntime([addTool().tool]);
        faux.setResponses([
          toolUse(fauxToolCall("add", { left: 2, right: 3 })),
          fauxAssistantMessage("It is 5."),
        ]);

        const events = await collect(toolRunner.start("What is 2 + 3?"));

        const appended = events.flatMap((event) =>
          event.type === "message_appended" ? [event.message] : [],
        );
        expect(appended).toEqual(toolRunner.log);
        expect(events.at(-1)).toEqual({
          type: "run_end",
          message: toolRunner.log.at(-1),
        });
      });
    });

    describe("failed calls", () => {
      async function runOneCall(
        tools: readonly RegisteredTool[],
        call: ToolCall,
        names?: string[],
      ) {
        const toolRunner = toolRuntime(tools, names);
        faux.setResponses([toolUse(call), fauxAssistantMessage("Sorry.")]);
        const message = await toolRunner.start("Go").result();
        return { message, result: toolRunner.log[2] };
      }

      it("reports a tool the template did not name", async () => {
        const add = addTool();

        const { message, result } = await runOneCall(
          [echoTool, add.tool],
          fauxToolCall("add", { left: 2, right: 3 }),
          ["echo"],
        );

        expect(result).toMatchObject({
          isError: true,
          content: [{ type: "text", text: 'Tool "add" is not available.' }],
        });
        expect(add.calls).toEqual([]);
        expect(message.stopReason).toBe("stop");
      });

      it("reports arguments that are not a JSON object", async () => {
        const add = addTool();
        const call = {
          ...fauxToolCall("add", {}),
          argumentsError: "Expected a JSON object, got: oops",
        };
        const toolRunner = toolRuntime([add.tool]);
        // The faux provider rebuilds tool calls and drops `argumentsError`,
        // so this response comes straight from a stream instead.
        vi.spyOn(models, "streamSimple").mockImplementationOnce(() => {
          const stream = createAssistantMessageEventStream();
          const message = toolUse(call);
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "toolUse", message });
          return stream;
        });
        faux.setResponses([fauxAssistantMessage("Sorry.")]);

        await toolRunner.start("Go").result();

        expect(toolRunner.log[2]).toMatchObject({
          isError: true,
          content: [
            { type: "text", text: "Expected a JSON object, got: oops" },
          ],
        });
        expect(add.calls).toEqual([]);
      });

      it("reports invalid arguments", async () => {
        const add = addTool();

        const { result } = await runOneCall(
          [add.tool],
          fauxToolCall("add", { left: "2", right: 3 }),
        );

        expect(result).toMatchObject({ isError: true });
        expect(summarize(result ? [result] : [])[0]).toContain(
          'Invalid arguments for tool "add" at /left',
        );
        expect(add.calls).toEqual([]);
      });

      it("reports a handler error and keeps going", async () => {
        const failing = defineTool({
          name: "save",
          description: "Save something.",
          parameters: Type.Object({}),
          execute: async () => {
            throw new Error("Disk is full");
          },
        });

        const { message, result } = await runOneCall(
          [failing],
          fauxToolCall("save", {}),
        );

        expect(result).toMatchObject({
          isError: true,
          content: [{ type: "text", text: "Disk is full" }],
        });
        expect(message.stopReason).toBe("stop");
      });
    });

    describe("calls that never run", () => {
      it("ignores tool calls in a message cut off for length", async () => {
        const add = addTool();
        const toolRunner = toolRuntime([add.tool]);
        faux.setResponses([
          fauxAssistantMessage([fauxToolCall("add", { left: 2, right: 3 })], {
            stopReason: "length",
          }),
        ]);

        const message = await toolRunner.start("Go").result();

        expect(message.stopReason).toBe("length");
        expect(toolRunner.log).toHaveLength(2);
        expect(add.calls).toEqual([]);
        expect(faux.state.callCount).toBe(1);
      });

      it("ends the run when the model stops for tool use without calls", async () => {
        const toolRunner = toolRuntime([addTool().tool]);
        faux.setResponses([
          fauxAssistantMessage("Let me think.", { stopReason: "toolUse" }),
        ]);

        const message = await toolRunner.start("Go").result();

        expect(message.stopReason).toBe("toolUse");
        expect(toolRunner.log).toHaveLength(2);
        expect(faux.state.callCount).toBe(1);
      });
    });

    describe("cancel while tools run", () => {
      const cancelled = "toolResult: Cancelled before completion.";

      it("cancels the running call and the calls after it", async () => {
        const held = heldTool("wait", { honorsSignal: true });
        const add = addTool();
        const toolRunner = toolRuntime([held.tool, add.tool]);
        faux.setResponses([
          toolUse(
            fauxToolCall("wait", {}),
            fauxToolCall("add", { left: 1, right: 1 }),
          ),
        ]);

        const run = toolRunner.start("Go");
        await held.started;
        toolRunner.cancel();
        const message = await run.result();

        expect(message).toMatchObject({ stopReason: "aborted", content: [] });
        expect(summarize(toolRunner.log)).toEqual([
          "user: Go",
          "assistant: toolCalltoolCall",
          cancelled,
          cancelled,
          "assistant: ",
        ]);
        expect(toolRunner.log.slice(2, 4)).toMatchObject([
          { toolName: "wait", isError: true },
          { toolName: "add", isError: true },
        ]);
        expect(toolRunner.log.at(-1)).toBe(message);
        expect(toolRunner.isRunning).toBe(false);
        expect(add.calls).toEqual([]);
        expect(faux.state.callCount).toBe(1);
      });

      it("ends the run even when a tool ignores the signal", async () => {
        const held = heldTool("wait", { honorsSignal: false });
        const toolRunner = toolRuntime([held.tool]);
        faux.setResponses([toolUse(fauxToolCall("wait", {}))]);

        const run = toolRunner.start("Go");
        await held.started;
        toolRunner.cancel();
        const message = await run.result();
        held.release();
        await new Promise((resolve) => setTimeout(resolve, 1));

        expect(message.stopReason).toBe("aborted");
        expect(summarize(toolRunner.log).slice(2)).toEqual([
          cancelled,
          "assistant: ",
        ]);
      });

      it("keeps the results of calls that finished first", async () => {
        const held = heldTool("wait", { honorsSignal: true });
        const toolRunner = toolRuntime([addTool().tool, held.tool]);
        faux.setResponses([
          toolUse(
            fauxToolCall("add", { left: 2, right: 3 }),
            fauxToolCall("wait", {}),
          ),
        ]);

        const run = toolRunner.start("Go");
        await held.started;
        toolRunner.cancel();
        await run.result();

        expect(summarize(toolRunner.log).slice(2)).toEqual([
          "toolResult: 5",
          cancelled,
          "assistant: ",
        ]);
      });

      it("keeps every result when cancelled during the next request", async () => {
        const toolRunner = toolRuntime([addTool().tool]);
        faux.setResponses([
          toolUse(fauxToolCall("add", { left: 2, right: 3 })),
          () => {
            toolRunner.cancel();
            return fauxAssistantMessage("Too late.");
          },
        ]);

        const message = await toolRunner.start("Go").result();

        expect(message.stopReason).toBe("aborted");
        expect(toolRunner.log).toHaveLength(4);
        expect(toolRunner.log[2]).toMatchObject({ isError: false });
        expect(toolRunner.log[3]).toBe(message);
      });

      it("sends the cancelled results in the next run", async () => {
        const held = heldTool("wait", { honorsSignal: true });
        const toolRunner = toolRuntime([held.tool]);
        const contexts: string[][] = [];
        faux.setResponses([
          toolUse(fauxToolCall("wait", {})),
          (context: TranscriptContext) => {
            contexts.push(summarize(context.messages));
            return fauxAssistantMessage("Hello again!");
          },
        ]);

        const run = toolRunner.start("Go");
        await held.started;
        toolRunner.cancel();
        await run.result();
        const message = await toolRunner.start("Try again").result();

        expect(message.stopReason).toBe("stop");
        // The runtime sends the whole log. Real provider APIs then drop the
        // aborted message; the faux provider does not, so it shows up here.
        expect(contexts[0]).toEqual([
          "system: You are a helpful assistant.",
          "user: Go",
          "assistant: toolCall",
          cancelled,
          "assistant: ",
          "user: Try again",
        ]);
      });
    });
  });
});
