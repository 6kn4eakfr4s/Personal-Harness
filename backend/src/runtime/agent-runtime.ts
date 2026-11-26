import { randomUUID } from "node:crypto";
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  EventStream,
  type Message,
  type Models,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { AgentTemplate } from "../config/agent-template.js";
import type { RegisteredTool, ToolResult } from "./tool.js";
import type { ToolRegistry } from "./tool-registry.js";

/** What happens during one run, in order. */
export type RunEvent =
  /** A message was appended to the log. */
  | { type: "message_appended"; message: Message }
  /** The model produced part of its response. Not stored in the log. */
  | { type: "model_event"; event: AssistantMessageEvent }
  /** The run is over. `message` is the last message of the log. */
  | { type: "run_end"; message: AssistantMessage };

/**
 * One run, as seen by whoever started it. Iterate it for events, or await
 * `result()` for the final assistant message. The run goes on whether or
 * not anyone reads it.
 */
export interface Run extends AsyncIterable<RunEvent> {
  /**
   * The final assistant message. Never rejects: a model error or a cancel
   * shows up as its `stopReason`, "error" or "aborted".
   */
  result(): Promise<AssistantMessage>;
}

export interface AgentRuntimeOptions {
  template: AgentTemplate;
  /** Model access. The runtime does not create it or read credentials. */
  models: Models;
  /** The shared tools. The runtime uses only those its template names. */
  tools: ToolRegistry;
  /** An existing log to resume from. It is copied, not modified. */
  log?: readonly Message[];
}

/** One running agent: one template, its own log, at most one active run. */
export class AgentRuntime {
  /** Identifies this runtime, not its template. Tools receive it as `agentId`. */
  readonly id = randomUUID();
  readonly template: AgentTemplate;
  private readonly models: Models;
  private readonly messages: Message[];
  /** The template's tools, for dispatching the model's calls. */
  private readonly toolsByName: ReadonlyMap<string, RegisteredTool>;
  /** The same tools as the model sees them. */
  private readonly toolDefinitions: readonly Tool[];
  /** Aborts the active run. Undefined when no run is active. */
  private activeRun: AbortController | undefined;

  /**
   * Throws if the template names a tool the registry does not have, or
   * names one twice. The error starts with the template ID.
   */
  constructor(options: AgentRuntimeOptions) {
    this.template = options.template;
    this.models = options.models;
    this.messages = [...(options.log ?? [])];

    let tools: readonly RegisteredTool[];
    try {
      tools = options.tools.resolve(this.template.tools);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Agent template "${this.template.id}": ${message}`, {
        cause: error,
      });
    }

    this.toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
    this.toolDefinitions = tools.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  }

  /** Every message so far, oldest first. Only the runtime appends to it. */
  get log(): readonly Message[] {
    return this.messages;
  }

  get isRunning(): boolean {
    return this.activeRun !== undefined;
  }

  /**
   * Start a run with a user message and return at once. The user message
   * is already in the log when this returns.
   *
   * Throws if a run is active; the message is then not added to the log.
   */
  start(text: string): Run {
    if (this.activeRun !== undefined) {
      throw new Error(
        "A run is already active. " +
          "Wait for it to end or cancel it before starting another.",
      );
    }

    const controller = new AbortController();
    const run = new RunStream();

    this.activeRun = controller;
    this.append(run, { role: "user", content: text, timestamp: Date.now() });
    void this.finishRun(run, controller.signal);

    return run;
  }

  /** Cancel the active run. Does nothing when no run is active. */
  cancel(): void {
    this.activeRun?.abort();
  }

  /**
   * Request the model and run the tool calls it asks for until it stops
   * asking, then end the run.
   */
  private async finishRun(run: RunStream, signal: AbortSignal): Promise<void> {
    let message: AssistantMessage;

    for (;;) {
      message = await this.requestModel(run, signal);
      this.append(run, message);

      // Calls in a message cut off for another reason, such as length, never run.
      if (message.stopReason !== "toolUse") {
        break;
      }
      const calls = message.content.filter(
        (block): block is ToolCall => block.type === "toolCall",
      );
      if (calls.length === 0) {
        break;
      }

      const finished = await this.runToolCalls(run, calls, signal);
      if (!finished) {
        message = this.emptyAssistantMessage(message.api, "aborted");
        this.append(run, message);
        break;
      }
    }

    this.activeRun = undefined;
    run.push({ type: "run_end", message });
  }

  /**
   * Send the log to the model once and resolve to its final message.
   * Never rejects: a failure becomes a message with stop reason "error".
   */
  private async requestModel(
    run: RunStream,
    signal: AbortSignal,
  ): Promise<AssistantMessage> {
    const { providerId, modelId } = this.template.model;
    const model = this.models.getModel(providerId, modelId);

    if (model === undefined) {
      return this.emptyAssistantMessage(
        unknownApi,
        "error",
        `Unknown model "${providerId}/${modelId}".`,
      );
    }

    try {
      const stream = this.models.streamSimple(
        model,
        {
          systemPrompt: this.template.systemPrompt,
          messages: [...this.messages],
          ...(this.toolDefinitions.length > 0
            ? { tools: [...this.toolDefinitions] }
            : {}),
        },
        { signal },
      );

      for await (const event of stream) {
        run.push({ type: "model_event", event });
      }

      return await stream.result();
    } catch (error) {
      // pi-ai reports failures through the stream. This only guards against
      // a provider that throws anyway, so a run can never stay active.
      const message = error instanceof Error ? error.message : String(error);
      return this.emptyAssistantMessage(model.api, "error", message);
    }
  }

  /**
   * Run `calls` one at a time, appending each result as it arrives.
   *
   * Resolves to false if the run was cancelled. The call that was cut off
   * and every call after it then get a cancelled result, so each call in
   * the log still has exactly one result.
   */
  private async runToolCalls(
    run: RunStream,
    calls: readonly ToolCall[],
    signal: AbortSignal,
  ): Promise<boolean> {
    for (const [index, call] of calls.entries()) {
      const result = signal.aborted
        ? undefined
        : await this.runToolCall(call, signal);

      if (result === undefined) {
        for (const unfinished of calls.slice(index)) {
          this.append(
            run,
            toolResultMessage(unfinished, cancelledResult, true),
          );
        }
        return false;
      }

      this.append(run, result);
    }
    return true;
  }

  /**
   * Run one call and wrap its outcome for the log. Anything that goes wrong
   * becomes an error result for the model. Resolves to undefined if the run
   * is cancelled before the tool returns.
   */
  private async runToolCall(
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<ToolResultMessage | undefined> {
    const tool = this.toolsByName.get(call.name);
    if (tool === undefined) {
      const text = `Tool "${call.name}" is not available.`;
      return toolResultMessage(
        call,
        { content: [{ type: "text", text }] },
        true,
      );
    }

    // pi-ai sets this when the model's arguments were not a JSON object.
    if (call.argumentsError !== undefined) {
      return toolResultMessage(
        call,
        { content: [{ type: "text", text: call.argumentsError }] },
        true,
      );
    }

    try {
      const context = { agentId: this.id, toolCallId: call.id, signal };
      // A tool may ignore the signal, so do not wait for it after a cancel.
      const result = await untilAborted(
        tool.execute(call.arguments, context),
        signal,
      );
      return toolResultMessage(call, result, false);
    } catch (error) {
      if (signal.aborted) {
        return undefined;
      }
      const text = error instanceof Error ? error.message : String(error);
      return toolResultMessage(
        call,
        { content: [{ type: "text", text }] },
        true,
      );
    }
  }

  private append(run: RunStream, message: Message): void {
    this.messages.push(message);
    run.push({ type: "message_appended", message });
  }

  /**
   * An assistant message the runtime makes itself: for a request that failed
   * without a response, or for a run cancelled while tools were running.
   */
  private emptyAssistantMessage(
    api: string,
    stopReason: "error" | "aborted",
    errorMessage?: string,
  ): AssistantMessage {
    return {
      role: "assistant",
      content: [],
      api,
      provider: this.template.model.providerId,
      model: this.template.model.modelId,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason,
      ...(errorMessage === undefined ? {} : { errorMessage }),
      timestamp: Date.now(),
    };
  }
}

/** `api` of a failure message made before any model was resolved. */
const unknownApi = "unknown";

/** What a call that never finished records as its result. */
const cancelledResult: ToolResult = {
  content: [{ type: "text", text: "Cancelled before completion." }],
};

function toolResultMessage(
  call: ToolCall,
  result: ToolResult,
  isError: boolean,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: result.content,
    isError,
    timestamp: Date.now(),
  };
}

/**
 * Settle with `promise`, or reject with the signal's reason as soon as it
 * aborts, whichever comes first.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** The events of one run. It ends with `run_end`, which carries the result. */
class RunStream extends EventStream<RunEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === "run_end",
      (event) => {
        if (event.type !== "run_end") {
          throw new Error("Unexpected event type for final result");
        }
        return event.message;
      },
    );
  }
}
