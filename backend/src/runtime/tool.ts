import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { Static, TObject } from "typebox";
import { Value } from "typebox/value";
import { isToolName } from "../config/agent-template.js";

/** What a tool returns. The runtime wraps it in a `ToolResultMessage`. */
export type ToolResult = Pick<ToolResultMessage, "content">;

/**
 * Per-call information. Tools are shared between agents, so anything about
 * the calling agent arrives here rather than being captured by the tool.
 */
export interface ToolExecutionContext {
  /** The runtime instance making the call, not its template. */
  readonly agentId: string;
  /** The model's ID for this tool call. */
  readonly toolCallId: string;
  /** Aborted when the run is cancelled. Pass it to any async work. */
  readonly signal: AbortSignal;
}

/** A tool as its author writes it. */
export interface ToolDefinition<Schema extends TObject> {
  name: string;
  description: string;
  /** A TypeBox object schema for the arguments. */
  parameters: Schema;
  /** Runs with arguments that already match `parameters`. */
  execute: (
    args: Static<Schema>,
    context: ToolExecutionContext,
  ) => Promise<ToolResult>;
}

/**
 * A tool ready to register. `execute` takes unknown arguments and validates
 * them against `parameters` before calling the author's handler.
 */
export interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: TObject;
  readonly execute: (
    args: unknown,
    context: ToolExecutionContext,
  ) => Promise<ToolResult>;
}

/**
 * Turn a tool definition into a frozen `RegisteredTool`.
 *
 * Throws at once if the name breaks the tool naming rule or the description
 * is blank. The fields are snapshotted and the schema is deeply cloned and
 * frozen, so later changes to `definition` have no effect.
 *
 * The returned `execute` rejects if the signal is already aborted (with its
 * reason, an `AbortError` by default), or if the arguments fail the schema.
 * Arguments are checked as given: nothing is converted, trimmed, defaulted
 * or removed. Errors from the handler pass through unchanged. Turning any of
 * these into a result for the model is the runtime's job.
 */
export function defineTool<const Schema extends TObject>(
  definition: ToolDefinition<Schema>,
): RegisteredTool {
  const { name, description, execute } = definition;

  if (!isToolName(name)) {
    throw new Error(
      `Invalid tool name "${name}". A tool name is a lowercase letter, ` +
        "then up to 63 lowercase letters, digits or underscores.",
    );
  }

  if (description.trim() === "") {
    throw new Error(`Tool "${name}" must have a non-blank description.`);
  }

  const parameters = deepFreeze(Value.Clone(definition.parameters));

  return Object.freeze({
    name,
    description,
    parameters,
    async execute(
      args: unknown,
      context: ToolExecutionContext,
    ): Promise<ToolResult> {
      context.signal.throwIfAborted();

      if (!Value.Check(parameters, args)) {
        const [error] = Value.Errors(parameters, args);
        const path = error?.instancePath || "/";
        const message = error?.message ?? "do not match the schema";
        throw new Error(
          `Invalid arguments for tool "${name}" at ${path}: ${message}`,
        );
      }

      return execute(args, context);
    },
  });
}

/** Freeze `value` and everything reachable from its own properties. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.freeze(value);
    // Own keys, not just enumerable ones: TypeBox keeps `~kind` hidden.
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze(Reflect.get(value, key));
    }
  }
  return value;
}
