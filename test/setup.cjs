// Load before any server import so a fresh clone can run mocked model tests.
// These values are test placeholders, never real credentials.
process.env.PORT = '0';
process.env.LLM_API_KEY = 'unit-test-key';
process.env.LLM_BASE_URL = 'https://llm.invalid/v1';
