# Provider Routing

Goblintown stores provider routes in `.goblintown/warren.json` and secrets in
`.goblintown/provider-secrets.json`. Environment variables win over saved local
secrets.

## Presets

The provider UI and CLI know these preset families:

- OpenAI
- OpenRouter
- Ollama
- LM Studio
- Groq
- Together AI
- Mistral
- DeepSeek
- Anthropic
- Gemini
- custom OpenAI-compatible base URLs

## Slots

Routes are per creature slot:

```bash
goblintown route set goblin --preset ollama --model gemma3:27b
goblintown route set troll --preset openrouter --model openai/gpt-4o-mini
goblintown route set ogre --preset openai --model gpt-5.5
goblintown route set scribe --preset openai --model gpt-4o-mini
```

Slots can be cleared:

```bash
goblintown route clear goblin
```

## Secrets

Common environment variables:

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENROUTER_API_KEY`
- `GROQ_API_KEY`
- `TOGETHER_API_KEY`
- `MISTRAL_API_KEY`
- `DEEPSEEK_API_KEY`
- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY`

Do not commit `.goblintown/provider-secrets.json`.

## Provider Packages

Use `.agents/skills/add-provider-package/SKILL.md` only when a provider needs a
real SDK adapter or package-level integration. For OpenAI-compatible endpoints,
prefer route configuration.
