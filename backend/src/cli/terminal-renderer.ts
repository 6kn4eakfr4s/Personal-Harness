import type {
  AssistantMessage,
  AssistantMessageEvent,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { RunEvent } from "../runtime/agent-runtime.js";

/** The longest tool argument or result text shown before truncating. */
const maxToolTextLength = 200;

/**
 * Turns the events of one run into terminal text. Streamed text is written
 * as it arrives; each tool call, tool result, and abnormal end gets a line
 * of its own. Thinking is not shown.
 *
 * Use a new renderer for each run.
 */
export class TerminalRenderer {
  private readonly write: (text: string) => void;
  /** Whether the last output did not end with a newline. */
  private midLine = false;

  constructor(write: (text: string) => void) {
    this.write = write;
  }

  render(event: RunEvent): void {
    switch (event.type) {
      case "model_event":
        this.renderModelEvent(event.event);
        break;
      case "message_appended":
        // User text was typed by the user; assistant text was streamed.
        if (event.message.role === "toolResult") {
          this.renderToolResult(event.message);
        }
        break;
      case "run_end":
        this.renderEnd(event.message);
        break;
    }
  }

  private renderModelEvent(event: AssistantMessageEvent): void {
    if (event.type === "text_delta") {
      this.print(event.delta);
    } else if (event.type === "toolcall_end") {
      this.renderToolCall(event.toolCall);
    }
  }

  private renderToolCall(call: ToolCall): void {
    const args = toolText(JSON.stringify(call.arguments));
    this.printLine(`[tool] ${call.name} ${args}`);
  }

  private renderToolResult(message: ToolResultMessage): void {
    const label = message.isError ? "[error]" : "[result]";
    const text = toolText(message.content.map(blockText).join(" "));
    this.printLine(text === "" ? label : `${label} ${text}`);
  }

  private renderEnd(message: AssistantMessage): void {
    switch (message.stopReason) {
      case "error":
        this.printLine(
          `[error] ${message.errorMessage ?? "The model request failed."}`,
        );
        break;
      case "aborted":
        this.printLine("(cancelled)");
        break;
      case "length":
        this.printLine("(response cut off: length limit reached)");
        break;
      default:
        this.endLine();
    }
  }

  /** Write `text` on its own line, ending the current line first. */
  private printLine(text: string): void {
    this.endLine();
    this.print(`${text}\n`);
  }

  /** End the current line if the last output stopped in the middle of one. */
  private endLine(): void {
    if (this.midLine) {
      this.print("\n");
    }
  }

  private print(text: string): void {
    if (text === "") {
      return;
    }
    this.write(text);
    this.midLine = !text.endsWith("\n");
  }
}

/** A result block as text: its text, or a placeholder such as "[image]". */
function blockText(block: ToolResultMessage["content"][number]): string {
  return block.type === "text" ? block.text : `[${block.type}]`;
}

/**
 * Fit tool text on one line: newlines become spaces, and text longer than
 * `maxToolTextLength` characters is cut and ends with "…".
 */
function toolText(text: string): string {
  const flat = text.replace(/\r\n|\r|\n/g, " ");
  // Count code points, so a cut never splits a surrogate pair.
  const chars = Array.from(flat);
  return chars.length > maxToolTextLength
    ? `${chars.slice(0, maxToolTextLength).join("")}…`
    : flat;
}
