import {
  type AssistantMessage,
  createModels,
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxProvider,
  type Message,
  type MutableModels,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTemplate } from "../config/agent-template.js";
import { AgentRuntime, type Run, type RunEvent } from "./agent-runtime.js";

const template = {
  id: "assistant",
  name: "Helpful Assistant",
  systemPrompt: "You are a helpful assistant.",
  model: { providerId: "faux", modelId: "faux-1" },
} satisfies AgentTemplate;

let faux: FauxProviderHandle;
let models: MutableModels;
let runtime: AgentRuntime;

beforeEach(() => {
  faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  models = createModels();
  models.setProvider(faux.provider);
  runtime = new AgentRuntime({ template, models });
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
      const resumed = new AgentRuntime({ template, models, log: earlier });
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
});
