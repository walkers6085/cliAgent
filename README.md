# cliAgent

Терминальный AI-агент для работы с кодом:

- **только терминал**: TUI и `cliagent run`; сетевого сервера, web UI, desktop-приложения нет — ядро работает в том же процессе, порты не открываются;
- **нет встроенных провайдеров**: никакого каталога models.dev, Zen/Go, Copilot, OAuth-плагинов. Провайдер появляется только если описан в конфиге, и любой провайдер работает через OpenAI-совместимый API (`@ai-sdk/openai-compatible`);
- **нет облака**: аккаунтов, share-ссылок, телеметрии, автообновления, GitHub-агента и ACP;
- **интернет есть**: запросы к LLM, инструменты `webfetch` и `websearch` (Exa), удалённые MCP-серверы. Прокси берётся из `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`.

## Установка

Нужен [Bun](https://bun.sh) 1.3.14.

```bash
bun install
bun run --cwd packages/cliagent script/build.ts --single --skip-install
ln -sf "$PWD/packages/cliagent/dist/cliagent-linux-x64/bin/cliagent" ~/.local/bin/cliagent
```

Без сборки, из исходников: `bun dev` (то же, что `cliagent`).

## Конфиг

Глобальный конфиг — `~/.config/cliagent/cliagent.json` (или `.jsonc`), проектный — `cliagent.json` в корне проекта или `.cliagent/cliagent.json`. Данные и сессии лежат в `~/.local/share/cliagent`, кэш — в `~/.cache/cliagent`.

```jsonc
{
  "provider": {
    "mistral": {
      "name": "Mistral",
      "env": ["MISTRAL_API_KEY"],
      "options": { "baseURL": "https://api.mistral.ai/v1" },
      "models": {
        "mistral-medium-latest": { "tool_call": true },
        "mistral-small-latest": { "tool_call": true }
      }
    },
    "zai": {
      "name": "Z.ai",
      "env": ["ZAI_API_KEY"],
      "options": { "baseURL": "https://api.z.ai/api/paas/v4", "thinking": { "type": "disabled" } },
      "models": { "glm-4.5-flash": { "tool_call": true } }
    }
  },
  "model": "mistral/mistral-medium-latest",
  "small_model": "zai/glm-4.5-flash"
}
```

- `options.baseURL` — обязателен, это адрес OpenAI-совместимого API.
- Ключ берётся из переменных в `env`, из `options.apiKey` (можно `"{env:MY_KEY}"`) или из хранилища: `cliagent providers login -p mistral`.
- `model` — модель по умолчанию в формате `провайдер/модель`; `small_model` — для заголовков сессий и других мелких задач.
- Поле `npm` игнорируется: SDK всегда `@ai-sdk/openai-compatible`.
- У модели можно задать `name`, `limit.context`, `limit.output`, `tool_call`, `reasoning`, `modalities`, `options`, `headers`, `variants`; у провайдера — `whitelist` / `blacklist` моделей.

## Команды

```bash
cliagent                     # TUI в текущем каталоге
cliagent run "задача"        # один запрос без интерфейса
cliagent --mini              # компактный интерактивный режим
cliagent models              # модели из конфига
cliagent providers list      # сохранённые ключи и найденные переменные окружения
cliagent providers login     # сохранить API-ключ
cliagent mcp add             # подключить MCP-сервер
cliagent session list        # сессии
```

Переменные окружения называются `CLIAGENT_*` (например, `CLIAGENT_CONFIG`, `CLIAGENT_CONFIG_CONTENT`).

## Разработка

```bash
cd packages/cliagent && bun typecheck   # проверка типов (по одному пакету)
cd packages/cliagent && bun test        # тесты (не из корня репозитория)
```

Структура: `packages/cliagent` — CLI и ядро сессий, `packages/core` — сервисы v2, `packages/tui` — интерфейс, `packages/server` и `packages/protocol` — внутренний API, `packages/sdk/js` — сгенерированный клиент, `packages/llm` — протокол OpenAI-совместимого чата.

## Лицензия

MIT. См. [LICENSE](LICENSE).
