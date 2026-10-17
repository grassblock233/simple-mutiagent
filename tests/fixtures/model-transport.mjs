// Installed only by the integration-test Node process; no application test endpoint exists.
if (process.env.DEEPSEEK_API_KEY !== "integration-sentinel-not-real") {
  throw new Error("The HTTP fixture requires its sentinel key");
}
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url) !== "https://api.deepseek.com/chat/completions") return nativeFetch(url, init);
  await new Promise(resolve => setTimeout(resolve, 30));
  const { messages } = JSON.parse(init.body);
  const input = JSON.parse(messages[1].content);
  const outputs = messages.filter(message => message.role === "tool");
  const results = outputs.map(message => JSON.parse(message.content));
  const current = results.findLast(result => result.version)?.version ?? input.version;
  const read = results.find(result => typeof result.content === "string");
  const kind = input.prompt;
  let name = "submit_result", args;
  if (!outputs.length) {
    name = "read_file";
    args = { path: "src/math.js", version: current, startLine: 1, endLine: 1 };
  } else if (kind === "HTTP_TEST:repair" && outputs.length === 1) {
    name = "submit_patch";
    args = { path: "src/math.js", version: current, before: "module.exports=(a,b)=>a-b;", after: "module.exports=(a,b)=>a+b;" };
  } else if (input.requireValidation && outputs.length === 1) {
    name = "request_check";
    args = { commandIndex: 0, version: current };
  } else if (kind === "HTTP_TEST:repair") {
    args = { resolutions: [{ issueId: input.originalIssues[0].id, explanation: "fixed operator" }], unrepairable: [] };
  } else {
    const rereview = kind === "HTTP_TEST:rereview";
    const issue = { id: rereview ? input.originalIssues[0].id : "candidate", path: "src/math.js", version: current, startLine: 1, endLine: 1, severity: "blocking", description: "wrong operator", evidence: "a-b", suggestion: "a+b", status: rereview ? "resolved" : "open" };
    args = { type: "review", version: current, scope: input.scope, issues: rereview || read.content.includes("a-b") ? [issue] : [], validations: [], limitations: [] };
  }
  return Response.json({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "fixture-" + outputs.length, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
};
