/**
 * OpenAI Responses API Adapter Test
 *
 * Tests different request formats to find the one that works with the proxy.
 *
 * Run with: bun backend/packages/composer/tests/OpenAIResponsesAdapter.test.ts
 */

const TEST_CONFIG = {

  name: "CodexCli",
  provider: "codex_cli",
  model: "gpt-5.2",
  apiKind: "openai_responses",
  maxOutputTokens: 128000,
  maxInputTokens: 128000,
  apiKey: "M6JUBQS0-0PXC-T3TD-JMP6-78GQ3RSE9PNF",
  baseUrl: "https://yunyi.cfd/codex",
};

const API_URL = `${TEST_CONFIG.baseUrl}/responses`;

interface TestResult {
  format: string;
  success: boolean;
  status?: number;
  error?: string;
  response?: string;
}

/**
 * Test Format 1: instructions (string) + input (string)
 */
async function testFormat1(): Promise<TestResult> {
  const format = "Format 1: instructions (string) + input (string)";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: TEST_CONFIG.model,
    instructions: "You are a helpful assistant.",
    input: "Hello, who are you?",
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 2: instructions (string) + input (array without system)
 */
async function testFormat2(): Promise<TestResult> {
  const format = "Format 2: instructions (string) + input (array without system)";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: TEST_CONFIG.model,
    instructions: "You are a helpful assistant.",
    input: [{ role: "user", content: "Hello, who are you?" }],
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 3: No instructions + input (array with system message)
 */
async function testFormat3(): Promise<TestResult> {
  const format = "Format 3: No instructions + input (array with system)";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: TEST_CONFIG.model,
    input: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello, who are you?" },
    ],
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 4: Both instructions + input (array with system)
 */
async function testFormat4(): Promise<TestResult> {
  const format = "Format 4: Both instructions + input (array with system)";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: TEST_CONFIG.model,
    instructions: "You are a helpful assistant.",
    input: [
      { role: "system", content: "Additional system context." },
      { role: "user", content: "Hello, who are you?" },
    ],
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 5: input with "type" field (Codex-style)
 */
async function testFormat5(): Promise<TestResult> {
  const format = "Format 5: input with type field (Codex-style)";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: TEST_CONFIG.model,
    input: [
      { type: "message", role: "system", content: "You are a helpful assistant." },
      { type: "message", role: "user", content: "Hello, who are you?" },
    ],
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 6: instructions as array (non-standard)
 */
async function testFormat6(): Promise<TestResult> {
  const format = "Format 6: instructions as array";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: TEST_CONFIG.model,
    instructions: [{ role: "system", content: "You are a helpful assistant." }],
    input: [{ role: "user", content: "Hello, who are you?" }],
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 7: Minimal - just model and input string
 */
async function testFormat7(): Promise<TestResult> {
  const format = "Format 7: Minimal (model + input string only)";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: TEST_CONFIG.model,
    input: "Hello, who are you?",
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 8: Empty instructions string
 */
async function testFormat8(): Promise<TestResult> {
  const format = "Format 8: Empty instructions string";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: TEST_CONFIG.model,
    instructions: "",
    input: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello, who are you?" },
    ],
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 9: instructions with role object (developer role)
 */
async function testFormat9(): Promise<TestResult> {
  const format = "Format 9: instructions with developer role object";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: TEST_CONFIG.model,
    instructions: { role: "developer", content: "You are a helpful assistant." },
    input: [{ role: "user", content: "Hello, who are you?" }],
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 10: Try input with developer role instead of system
 */
async function testFormat10(): Promise<TestResult> {
  const format = "Format 10: input with developer role";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: TEST_CONFIG.model,
    input: [
      { role: "developer", content: "You are a helpful assistant." },
      { role: "user", content: "Hello, who are you?" },
    ],
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 11: Very simple instructions
 */
async function testFormat11(): Promise<TestResult> {
  const format = "Format 11: Very simple instructions (single word)";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: TEST_CONFIG.model,
    instructions: "Assistant",
    input: "Hello",
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 12: input with type: input_text
 */
async function testFormat12(): Promise<TestResult> {
  const format = "Format 12: input with type: input_text";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: TEST_CONFIG.model,
    instructions: "You are a helpful assistant.",
    input: [
      { type: "input_text", text: "Hello, who are you?" },
    ],
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 13: input item with content array (multi-part)
 */
async function testFormat13(): Promise<TestResult> {
  const format = "Format 13: input with content array";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: TEST_CONFIG.model,
    instructions: "You are a helpful assistant.",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "Hello, who are you?" }],
      },
    ],
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 14: Codex-style with type: message and content array
 */
async function testFormat14(): Promise<TestResult> {
  const format = "Format 14: type:message + content array";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: TEST_CONFIG.model,
    instructions: "You are a helpful assistant.",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Hello, who are you?" }],
      },
    ],
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 15: Test with null instructions
 */
async function testFormat15(): Promise<TestResult> {
  const format = "Format 15: instructions = null";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: TEST_CONFIG.model,
    instructions: null,
    input: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello, who are you?" },
    ],
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 16: Test without stream field
 */
async function testFormat16(): Promise<TestResult> {
  const format = "Format 16: No stream field";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: TEST_CONFIG.model,
    instructions: "You are a helpful assistant.",
    input: "Hello, who are you?",
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 17: Test with x-api-key header instead of Bearer
 */
async function testFormat17(): Promise<TestResult> {
  const format = "Format 17: x-api-key header";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: TEST_CONFIG.model,
    instructions: "You are a helpful assistant.",
    input: "Hello, who are you?",
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": TEST_CONFIG.apiKey,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 18: Test with api-key header (Azure style)
 */
async function testFormat18(): Promise<TestResult> {
  const format = "Format 18: api-key header (Azure style)";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: TEST_CONFIG.model,
    instructions: "You are a helpful assistant.",
    input: "Hello, who are you?",
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": TEST_CONFIG.apiKey,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 19: Exact format from OpenAI docs
 */
async function testFormat19(): Promise<TestResult> {
  const format = "Format 19: Exact OpenAI docs format";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: "gpt-5",
    reasoning: { effort: "low" },
    instructions: "Talk like a pirate.",
    input: "Are semicolons optional in JavaScript?",
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 20: With store: false
 */
async function testFormat20(): Promise<TestResult> {
  const format = "Format 20: With store: false";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: TEST_CONFIG.model,
    instructions: "You are a helpful assistant.",
    input: "Hello, who are you?",
    stream: false,
    store: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 21: Codex-style system prompt
 */
async function testFormat21(): Promise<TestResult> {
  const format = "Format 21: Codex-style system prompt";
  console.log(`\nTesting ${format}...`);

  const codexStyleInstructions = `You are Codex, a coding assistant made by OpenAI.

You are pair programming with a USER to help them write code and solve problems.
Every time the USER sends a message, we run a set of tools and autonomous agents to gather relevant information for the response.

<communication>
- Respond in the same language the user uses
- Do not output code without the user asking for it
- Be concise and helpful
</communication>`;

  const body = {
    model: TEST_CONFIG.model,
    instructions: codexStyleInstructions,
    input: "Hello, who are you?",
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 22: Base64 encoded instructions (unlikely but test anyway)
 */
async function testFormat22(): Promise<TestResult> {
  const format = "Format 22: Base64 encoded instructions";
  console.log(`\nTesting ${format}...`);

  const base64Payload = globalThis.btoa("You are a helpful assistant.");

  const body = {
    model: TEST_CONFIG.model,
    instructions: base64Payload,
    input: "Hello, who are you?",
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 23: With max_output_tokens
 */
async function testFormat23(): Promise<TestResult> {
  const format = "Format 23: With max_output_tokens";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: TEST_CONFIG.model,
    instructions: "You are a helpful assistant.",
    input: "Hello",
    max_output_tokens: 1000,
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 24: Test /v1/responses endpoint instead
 */
async function testFormat24(): Promise<TestResult> {
  const format = "Format 24: /v1/responses endpoint";
  console.log(`\nTesting ${format}...`);

  // Try adding /v1 prefix
  const urlWithV1 = TEST_CONFIG.baseUrl + "/v1/responses";
  console.log(`Using URL: ${urlWithV1}`);

  const body = {
    model: TEST_CONFIG.model,
    instructions: "You are a helpful assistant.",
    input: "Hello, who are you?",
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(urlWithV1, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 25: Just /codex endpoint (base URL as-is)
 */
async function testFormat25(): Promise<TestResult> {
  const format = "Format 25: Just base URL endpoint";
  console.log(`\nTesting ${format}...`);

  // Try the base URL directly (maybe it's already /responses)
  console.log(`Using URL: ${TEST_CONFIG.baseUrl}`);

  const body = {
    model: TEST_CONFIG.model,
    instructions: "You are a helpful assistant.",
    input: "Hello, who are you?",
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(TEST_CONFIG.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 26: With tools array (empty)
 */
async function testFormat26(): Promise<TestResult> {
  const format = "Format 26: With empty tools array";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: TEST_CONFIG.model,
    instructions: "You are a helpful assistant.",
    input: "Hello, who are you?",
    tools: [],
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 27: With Codex User-Agent
 */
async function testFormat27(): Promise<TestResult> {
  const format = "Format 27: Codex User-Agent header";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: TEST_CONFIG.model,
    instructions: "You are a helpful assistant.",
    input: "Hello, who are you?",
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
        "User-Agent": "codex-cli/1.0.0",
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 28: With OpenAI-Beta header
 */
async function testFormat28(): Promise<TestResult> {
  const format = "Format 28: OpenAI-Beta header";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: TEST_CONFIG.model,
    instructions: "You are a helpful assistant.",
    input: "Hello, who are you?",
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
        "OpenAI-Beta": "responses=v1",
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 29: Instructions with file reference (Codex-style)
 */
async function testFormat29(): Promise<TestResult> {
  const format = "Format 29: Instructions with @file reference";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: TEST_CONFIG.model,
    instructions: "@AGENTS.md\nYou are a helpful assistant.",
    input: "Hello, who are you?",
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 30: With text field instead of input
 */
async function testFormat30(): Promise<TestResult> {
  const format = "Format 30: 'text' field instead of 'input'";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: TEST_CONFIG.model,
    instructions: "You are a helpful assistant.",
    text: "Hello, who are you?",
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 31: With messages instead of input (Chat Completions style)
 */
async function testFormat31(): Promise<TestResult> {
  const format = "Format 31: 'messages' field (Chat Completions style)";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: TEST_CONFIG.model,
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello, who are you?" },
    ],
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

/**
 * Test Format 32: With both messages and instructions
 */
async function testFormat32(): Promise<TestResult> {
  const format = "Format 32: messages + instructions";
  console.log(`\nTesting ${format}...`);

  const body = {
    model: TEST_CONFIG.model,
    instructions: "You are a helpful assistant.",
    messages: [{ role: "user", content: "Hello, who are you?" }],
    stream: false,
  };

  console.log("Request body:", JSON.stringify(body, null, 2));

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${text.slice(0, 500)}`);

    if (response.ok) {
      return { format, success: true, status: response.status, response: text };
    }
    return { format, success: false, status: response.status, error: text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${error}`);
    return { format, success: false, error };
  }
}

// Run tests directly
async function runTests() {
  console.log("\n========================================");
  console.log("OpenAI Responses API Format Tests");
  console.log("========================================");
  console.log(`API URL: ${API_URL}`);
  console.log(`Model: ${TEST_CONFIG.model}`);
  console.log("========================================\n");

  const results: TestResult[] = [];

  results.push(await testFormat1());
  results.push(await testFormat2());
  results.push(await testFormat3());
  results.push(await testFormat4());
  results.push(await testFormat5());
  results.push(await testFormat6());
  results.push(await testFormat7());
  results.push(await testFormat8());
  results.push(await testFormat9());
  results.push(await testFormat10());
  results.push(await testFormat11());
  results.push(await testFormat12());
  results.push(await testFormat13());
  results.push(await testFormat14());
  results.push(await testFormat15());
  results.push(await testFormat16());
  results.push(await testFormat17());
  results.push(await testFormat18());
  results.push(await testFormat19());
  results.push(await testFormat20());
  results.push(await testFormat21());
  results.push(await testFormat22());
  results.push(await testFormat23());
  results.push(await testFormat24());
  results.push(await testFormat25());
  results.push(await testFormat26());
  results.push(await testFormat27());
  results.push(await testFormat28());
  results.push(await testFormat29());
  results.push(await testFormat30());
  results.push(await testFormat31());
  results.push(await testFormat32());

  console.log("\n========================================");
  console.log("SUMMARY");
  console.log("========================================");

  const successfulFormats = results.filter((r) => r.success);
  const failedFormats = results.filter((r) => !r.success);

  console.log(`\nSuccessful formats (${successfulFormats.length}):`);
  for (const r of successfulFormats) {
    console.log(`  ✓ ${r.format}`);
  }

  console.log(`\nFailed formats (${failedFormats.length}):`);
  for (const r of failedFormats) {
    console.log(`  ✗ ${r.format}: ${r.error?.slice(0, 100)}`);
  }

  return successfulFormats;
}

const bunRuntime = (globalThis as any)["Bun"] as
  | undefined
  | { env?: Record<string, string | undefined>; exit?: (code: number) => void };
const shouldRunLive = bunRuntime?.env?.RUN_OPENAI_RESPONSES === "1";

if (shouldRunLive) {
  runTests().then((successful) => {
    if (successful.length === 0) {
      console.log("\n❌ No format worked! Check the API endpoint and credentials.");
      bunRuntime?.exit?.(1);
    } else {
      console.log(`\n✅ Found ${successful.length} working format(s)!`);
      bunRuntime?.exit?.(0);
    }
  });
} else {
  console.log("Skipping OpenAI responses live test (set RUN_OPENAI_RESPONSES=1 to enable).\n");
}
