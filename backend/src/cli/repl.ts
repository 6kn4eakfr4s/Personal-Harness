import { createInterface, type Interface, type Key } from "node:readline";
import { Writable } from "node:stream";
import type { AgentRuntime } from "../runtime/agent-runtime.js";
import { TerminalRenderer } from "./terminal-renderer.js";

export interface ReplOptions {
  runtime: AgentRuntime;
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

/**
 * The terminal chat loop: one line is one turn. While a run is active
 * there is no prompt and typed lines are dropped.
 *
 * Ctrl+C cancels an active run, clears a typed line, or, pressed twice in
 * a row on an empty line, exits. Ctrl+D exits, cancelling any active run
 * first.
 */
export class Repl {
  private readonly runtime: AgentRuntime;
  private readonly output: NodeJS.WriteStream;
  /** What readline writes to: its prompt and the echo of typed keys. */
  private readonly echo: MutableOutput;
  private readonly readline: Interface;
  /**
   * The active turn: it settles once its run has ended and every event is
   * written. Undefined at the prompt.
   */
  private activeTurn: Promise<void> | undefined;
  /** Whether Ctrl+C was pressed on an empty line, with no key since. */
  private exitRequested = false;
  /** Resolves `start()`. */
  private resolveExit = () => {};

  constructor(options: ReplOptions) {
    this.runtime = options.runtime;
    this.output = options.output;
    this.echo = new MutableOutput(options.output);
    this.readline = createInterface({
      input: options.input,
      output: this.echo,
      prompt: "> ",
      terminal: Boolean(options.input.isTTY && options.output.isTTY),
    });

    this.readline.on("line", (line) => this.onLine(line));
    this.readline.on("SIGINT", () => this.onInterrupt());
    this.readline.on("close", () => void this.onClose());
    // readline emits keypress events on the input when it is a terminal.
    options.input.on("keypress", (_text: string, key: Key | undefined) => {
      if (!(key?.ctrl === true && key.name === "c")) {
        this.exitRequested = false;
      }
    });
  }

  /** Show the prompt and resolve once the user has exited. */
  start(): Promise<void> {
    const exited = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
    this.readline.prompt();
    return exited;
  }

  private onLine(line: string): void {
    if (this.activeTurn !== undefined) {
      return;
    }
    this.exitRequested = false;

    const text = line.trim();
    if (text === "") {
      this.readline.prompt();
      return;
    }
    this.activeTurn = this.runTurn(text);
  }

  /** Run one turn, writing its events, then prompt for the next. */
  private async runTurn(text: string): Promise<void> {
    const run = this.runtime.start(text);
    this.echo.muted = true;

    const renderer = new TerminalRenderer((chunk) => this.output.write(chunk));
    for await (const event of run) {
      renderer.render(event);
    }

    this.activeTurn = undefined;
    this.discardTypedText();
    this.echo.muted = false;
    if (!this.echo.closed) {
      this.readline.prompt();
    }
  }

  /** Ctrl+C. */
  private onInterrupt(): void {
    if (this.activeTurn !== undefined) {
      // The renderer writes "(cancelled)" when the run ends.
      this.runtime.cancel();
      return;
    }

    if (this.readline.line !== "") {
      this.exitRequested = false;
      this.clearLine();
      return;
    }

    if (this.exitRequested) {
      this.readline.close();
      return;
    }

    this.exitRequested = true;
    this.output.write("\n(To exit, press Ctrl+C again or Ctrl+D)\n");
    this.readline.prompt();
  }

  /** Ctrl+D, a second Ctrl+C, or the end of the input. */
  private async onClose(): Promise<void> {
    this.echo.closed = true;
    const turn = this.activeTurn;
    if (turn === undefined) {
      // Leave the shell prompt on a line of its own.
      this.output.write("\n");
    } else {
      this.runtime.cancel();
      await turn;
    }
    this.resolveExit();
  }

  /** Drop what was typed during a run, without showing it. */
  private discardTypedText(): void {
    if (!this.echo.closed) {
      this.clearLine();
    }
  }

  /** Empty the line being typed, as Ctrl+E then Ctrl+U would. */
  private clearLine(): void {
    if (this.readline.terminal) {
      this.readline.write(null, { ctrl: true, name: "e" });
      this.readline.write(null, { ctrl: true, name: "u" });
    }
  }
}

/**
 * Passes writes through to the terminal unless muted. Muting it during a
 * run keeps readline's echo of typed keys out of the run's output.
 */
class MutableOutput extends Writable {
  muted = false;
  /** Set once readline has closed. Nothing is written after that. */
  closed = false;
  private readonly target: NodeJS.WriteStream;

  constructor(target: NodeJS.WriteStream) {
    super();
    this.target = target;
    target.on("resize", () => this.emit("resize"));
  }

  /** readline reads this to wrap long lines. */
  get columns(): number {
    return this.target.columns;
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.muted && !this.closed) {
      this.target.write(chunk);
    }
    callback();
  }
}
