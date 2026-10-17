// Deliberately avoids the network for both successful and unsuccessful smoke-script assertions.
if (process.env.DEEPSEEK_API_KEY !== "smoke-sentinel-not-real") throw new Error("Expected smoke-test sentinel");
globalThis.fetch = async () => Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: process.env.SMOKE_RESPONSE === "valid" ? "OK" : null } }], usage: {} });
