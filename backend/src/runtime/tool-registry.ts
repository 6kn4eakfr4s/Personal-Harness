import type { RegisteredTool } from "./tool.js";

/**
 * The tools an application offers, shared by every agent runtime. Its
 * members are fixed at construction.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  /**
   * Index `tools` by name. Throws if two tools share a name. The array is
   * read, not kept, so changing it later has no effect.
   *
   * Tools are not checked again: `defineTool()` already did that.
   */
  constructor(tools: readonly RegisteredTool[]) {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) {
        throw new Error(`Tool "${tool.name}" is registered more than once.`);
      }
      this.tools.set(tool.name, tool);
    }
  }

  /**
   * The tools named in `names`, in that order, as a new frozen array of the
   * registered objects.
   *
   * Throws if a name is requested twice, or lists every unknown name in one
   * error. Nothing is returned when there is any error.
   */
  resolve(names: readonly string[]): readonly RegisteredTool[] {
    const resolved: RegisteredTool[] = [];
    const requested = new Set<string>();
    const unknown: string[] = [];

    for (const name of names) {
      if (requested.has(name)) {
        throw new Error(`Tool "${name}" is requested more than once.`);
      }
      requested.add(name);

      const tool = this.tools.get(name);
      if (tool === undefined) {
        unknown.push(name);
      } else {
        resolved.push(tool);
      }
    }

    if (unknown.length > 0) {
      const list = unknown.map((name) => `"${name}"`).join(", ");
      throw new Error(`Unknown tools: ${list}.`);
    }

    return Object.freeze(resolved);
  }
}
