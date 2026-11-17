import {
  type AssistantMessage,
  type AssistantMessageEvent,
  EventStream,
  type Message,
  type Models,
} from "@earendil-works/pi-ai";
import type { AgentTemplate } from "../config/agent-template.js";

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
  /** An existing log to resume from. It is copied, not modified. */
  log?: readonly Message[];
}

/** One running agent: one template, its own log, at most one active run. */
export class AgentRuntime {
  readonly template: AgentTemplate;
  private readonly models: Models;
  private readonly messages: Message[];
  /** Aborts the active run. Undefined when no run is active. */
  private activeRun: AbortController | undefined;

  constructor(options: AgentRuntimeOptions) {
    this.template = options.template;
    this.models = options.models;
    this.messages = [...(options.log ?? [])];
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

  /** Get the model's response, append it to the log, and end the run. */
  private async finishRun(run: RunStream, signal: AbortSignal): Promise<void> {
    const message = await this.requestModel(run, signal);

    this.append(run, message);
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
      return this.failureMessage(
        unknownApi,
        `Unknown model "${providerId}/${modelId}".`,
      );
    }

    try {
      const stream = this.models.streamSimple(
        model,
        {
          systemPrompt: this.template.systemPrompt,
          messages: [...this.messages],
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
      return this.failureMessage(
        model.api,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private append(run: RunStream, message: Message): void {
    this.messages.push(message);
    run.push({ type: "message_appended", message });
  }

  /** An assistant message for a request that failed without a response. */
  private failureMessage(api: string, errorMessage: string): AssistantMessage {
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
      stopReason: "error",
      errorMessage,
      timestamp: Date.now(),
    };
  }
}

/** `api` of a failure message made before any model was resolved. */
const unknownApi = "unknown";

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
