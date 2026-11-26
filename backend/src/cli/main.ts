import { parseArgs } from "node:util";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { loadAgentTemplates } from "../config/load-agent-templates.js";
import { AgentRuntime } from "../runtime/agent-runtime.js";
import { ToolRegistry } from "../runtime/tool-registry.js";
import { echoTool } from "../runtime/tools/echo.js";
import { Repl } from "./repl.js";
import { selectTemplate } from "./select-template.js";

/**
 * Build the runtime from the command line: parse it, load ./templates,
 * pick a template, and check that its model and tools exist. Throws with a
 * message for the user when any step fails.
 */
async function createRuntime(args: string[]): Promise<AgentRuntime> {
  const { values } = parseArgs({
    args,
    options: { template: { type: "string" } },
    strict: true,
    allowPositionals: false,
  });

  const templates = await loadAgentTemplates({
    baseDir: process.cwd(),
    templatesDir: "templates",
  });
  const template = selectTemplate(templates, values.template);

  // Credentials are not read here: pi-ai resolves them on each request.
  const models = builtinModels();
  const { providerId, modelId } = template.model;
  if (models.getModel(providerId, modelId) === undefined) {
    throw new Error(
      `Template "${template.id}" uses unknown model ` +
        `"${providerId}/${modelId}". ` +
        "Use a provider and model from the pi-ai catalog.",
    );
  }

  // Throws if the template names a tool that is not registered.
  return new AgentRuntime({
    template,
    models,
    tools: new ToolRegistry([echoTool]),
  });
}

async function main(): Promise<void> {
  let runtime: AgentRuntime;
  try {
    runtime = await createRuntime(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
    return;
  }

  const { name, model } = runtime.template;
  process.stdout.write(
    `${name} (${model.providerId}/${model.modelId})\n` +
      "Press Ctrl+C to cancel a reply, Ctrl+D to exit.\n",
  );

  await new Repl({
    runtime,
    input: process.stdin,
    output: process.stdout,
  }).start();
}

await main();
