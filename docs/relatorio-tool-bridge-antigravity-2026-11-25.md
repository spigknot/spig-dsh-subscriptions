# Ponte de Tool Calling do DSH (Variante 1A) na rota Google Antigravity

Data: 25/11/2026. Repositório `D:\Projetos\spig-dsh-subscriptions`, base `8dbfc54` com o trabalho ACP (não commitado) já presente. Nada foi commitado.

## 1. Contrato de `StreamChunk` verificado (DSH 0.2.2-rc.5)

Lido no `BlockAssembler` e no validador de chunks de `@deepseek-ai/dsh-llm` (dentro do `app.asar`) e nos tradutores do próprio `lib/index.js`:

| Chunk | Campos |
|---|---|
| `block-start` | `index`, `blockType` (`'text' \| 'reasoning' \| 'tool-call'`) — sem id/nome |
| `tool-call-delta` | `index`, `id` (string não vazia), `name` (string, opcional), `argumentsDelta` (**string**, obrigatória) |
| `block-end` | `index`, `block: { type:'tool-call', id, name, arguments }` — `arguments` é **texto JSON** |
| `finish` | `reason: { kind: 'tool-calls' }` ou `{ kind: 'stop' }` |
| resultado de ferramenta (entrada) | mensagem `role:'tool'` com `toolCallId`, `isError`, `content` (texto/imagem); **sem nome** da ferramenta |

## 2. Arquivos

| Arquivo | Papel |
|---|---|
| `lib/antigravity-tool-bridge.js` (novo) | Módulo puro: tag `dsh_tc_<12 hex>` por sessão, `shouldBridge`, `serializeToolsCompact` (4 níveis de descrição, teto padrão 32 KB, nunca remove ferramenta), `bridgeHeader`, `parseToolBridgeOutput`, `answerChunks`, `canonicalAnswer`, `noteInvalidCalls`, `invalidCallFeedback` |
| `lib/antigravity-cli-local.js` | Interruptor `setAgyToolBridge/agyToolBridge` (padrão ligado); `agyBridgeFor` (compartilhado pelos dois transportes); `BRIDGE_RULES` nega **todas** as ferramentas do `agy`, inclusive `read_file`/`read_url`; cabeçalho substitui o `ROUTE_NOTE`; histórico com chamadas no formato da ponte e resultados `[id=… name=… ERROR]`; imagem em resultado vira marcador de texto em vez de erro; guarda de 180 KB e `minimumBytes` contam o cabeçalho; estimativa de compactação conta a renderização da ponte; `agyBridgeReserveBytes(sessionId)` |
| `lib/antigravity-cli-adapter.js` | `streamCliResult` (caminho do modo `compaction` e do fallback do ACP) converte blocos em `tool-call` + `finish: tool-calls`; 1 nova tentativa com o motivo quando **todos** os blocos são inválidos |
| `lib/antigravity-acp-transport.js` | Ponte também no ACP: cabeçalho só na abertura/reconstrução da sessão `agy`; resposta bufferizada e reemitida como texto + chamadas (as tags cruas nunca chegam à tela); vínculo (`binding`) guarda `bridgeKey` (tag + catálogo) e reconhece respostas com chamadas pela forma canônica, então os resultados de ferramenta seguem **incrementais** na mesma sessão `agy` |
| `lib/antigravity-context-delivery.js` | Opção `bridge` (renderização da ponte; cabeçalho apenas quando não incremental) |
| `lib/antigravity-cli-recovery.js` | `reserveBytes`/`reserveFor`: a recuperação compacta até sobrar espaço para o cabeçalho |
| `lib/index.js`, `lib/provider-settings.js`, `lib/provider-settings.d.ts` | Preferência `agyToolBridge` (só Antigravity, booleana, ausente = ligada), RPC `setAgyToolBridge` (grava com `patch` e depois aplica), `status.agyToolBridge`, aplicada no `apply` |
| `lib/client.js` | Interruptor “Run DSH tools (shell, files) through the harness” visível nos dois transportes; `agyFix` só aparece com ponte desligada no modo compaction (o valor salvo não é apagado); textos `en` + `zh`; `mergeLatestAccounts` preserva `agyToolBridge` |
| Testes novos | `antigravity-tool-bridge.test.mjs` (11), `antigravity-tool-bridge-route.test.mjs` (13), `antigravity-acp-bridge.test.mjs` (4), `antigravity-tool-bridge-dsh.test.mjs` (E2E no runtime real); ampliados `provider-settings-contract.test.mjs` e `antigravity-cli-recovery.test.mjs` (+2) |

## 3. Interações

- **Quando a ponte age:** interruptor ligado **e** `options.tools` não vazio **e** `purpose !== 'compaction'`. Resumos de compactação nunca recebem catálogo.
- **Guarda de 180 KB:** medido sobre o prompt final (cabeçalho incluído); se só o cabeçalho + pedido não cabem, `INVALID_REQUEST`. A recuperação reserva os bytes do cabeçalho da sessão, evitando a recusa repetida após compactar.
- **`agyFix`:** com a ponte ativa a política é sempre `BRIDGE_RULES` (nega tudo do `agy`), independente do `agyFix`; sem ferramentas na chamada, o `agyFix` continua valendo como antes.
- **ACP:** a política ACP (escrita pelo outro trabalho) mantém `read_file` permitido para o arquivo `.md` de contexto antigo; o restante continua negado. Mudança de catálogo ou de tag (ex.: reinício do plugin, já que a tag fica em memória) reconstrói a sessão `agy`.
- **Regra do texto:** texto antes do último bloco é mantido; texto depois do último bloco é descartado quando há chamada válida (só pode ser resultado inventado); blocos com outra tag ou XML qualquer nunca viram chamada.

## 4. Resultados

Testes automatizados (sem cota):

- `node --check` em todos os módulos alterados: OK.
- `node --test --test-timeout=60000 "test/*.test.mjs"`: **149 testes, 149 passaram** (antes do trabalho: 68 testes, 65 passaram, 3 falhas eram testes ACP sem implementação, depois resolvidos pelo outro agente).
- Runtime real do DSH (`DSH_NODE_EXECUTABLE`, `ELECTRON_RUN_AS_NODE=1`): `antigravity-tool-bridge-dsh` + `antigravity-cli-overflow-dsh` + `antigravity-acp-dsh`: **9/9**. O E2E prova que o `agent-loop` real executou a ferramenta registrada (arquivo criado de fato), que o 2º prompt trouxe a chamada e o resultado real `WROTE 8 BYTES`, que o histórico do DSH guarda um bloco `tool-call` estruturado e que a política do `agy` negou tudo.

Teste de fumaça real (1 conversa, 2 chamadas ao `agy` 1.5.17, modelo `gemini-4-hydrogen-low`, ferramentas `read_demo` e `echo_shell`):

| Passo | Resultado | Latência | Tokens entrada/saída | Prompt enviado |
|---|---|---|---|---|
| 1 | `<dsh_tc_…>{"name":"read_demo","arguments":{"path":"demo.txt"}}</dsh_tc_…>` → `finish: tool-calls` | 39,0 s | 20.608 / 116 | 1.252 bytes |
| 2 | “The secret word written in `demo.txt` is **SEGREDO-ALFA-42**.” → `finish: stop` | 39,4 s | 20.754 / 112 | 1.622 bytes |

Catálogo: 369 bytes (2 ferramentas, nível 0). Formato acertado em 1/1 tentativa; nenhuma ferramenta interna do `agy` foi usada. Os ~20,6 mil tokens de entrada com um prompt de ~1,2 KB vêm do próprio `agy` (prompt de sistema dele), não da ponte.

Não medido: tamanho do catálogo com o conjunto real de ferramentas de uma sessão DSH (dezenas de ferramentas + MCP); taxa de acerto com mais chamadas, modelos maiores ou o modo ACP real; latência no ACP real.

## 5. Backup, ativação e limitações

- Backup anterior às edições: `D:\Projetos\backups\spig-dsh-subscriptions-pre-tool-bridge\` (`lib/`, `test/`, `docs/`, `package.json`, `git-status.txt`, `git-diff.patch`, `git-untracked.txt`). Restaurar: copiar `lib/` e `test/` de volta e apagar `lib/antigravity-tool-bridge.js` e os 4 testes novos. Observação: o backup é anterior ao trabalho ACP, então restaurá-lo também desfaz o ACP.
- Ativação: o plugin é carregado por symlink; o lado host (`lib/index.js` e módulos) só passa a valer depois de recarregar o plugin/reiniciar o DSH. Desligar: Configurações → Assinaturas → Antigravity → “Run DSH tools…”.
- Limitações:
  - A tag fica em memória: depois de reiniciar o plugin, a sessão ACP é reconstruída uma vez.
  - No ACP não há nova tentativa automática quando todos os blocos são inválidos (o texto vai com o aviso); no modo compaction há uma.
  - No ACP com a ponte, a resposta não aparece aos poucos (é bufferizada até terminar).
  - Modelos menores podem errar o JSON; o aviso visível no texto deixa o modelo corrigir no passo seguinte.
  - Durante o trabalho o `agy` passou de 1.5.16 para 1.5.17; o corte de ~192 KB não foi medido de novo nesta versão.
