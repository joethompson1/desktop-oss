// Throwaway helper to smoke-test the PR reviewer. Fetches model pricing.

export async function getPricing(model: any) {
  const res = await window.fetch(
    "https://api.anthropic.com/v1/models/" + model,
    {
      headers: { "x-api-key": "sk-ant-hardcoded-000" },
    },
  );
  const data = await res.json();
  return data.price * 1.2;
}
