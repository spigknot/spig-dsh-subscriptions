# Relatório — transporte persistente ACP na rota Antigravity (25/11/2026)

Ambiente: DSH 0.2.2-rc.5 (perfil `web`), `agy` **1.5.17** (não 1.5.16), Node 24.18, HEAD `8dbfc54`. Nada commitado, perfil não alterado.

## 1. Como o limite é contornado — evidências do experimento (Hydrogen Low)

| Teste | Resultado medido |
|---|---|
| 1 mensagem ACP de 300.000 B | **truncada**: `gen_metadata` mostra 191.986 B visíveis + `<truncated 108421 bytes>`; marcador final perdido |
| 190.000 B e 150.000 B | intactas, marcador devolvido |
| Turno 2 na mesma sessão (272 B, sem reenviar o fato) | lembrou `FATO-A-9182`; input 4.678, cache read 106.775 |
| `session/load` id inexistente | erro `-32002 Session not found` (não "sucesso vazio") |
| `session/load` id real | replay com `user_message_chunk` e `agent_message_chunk` |
| `--settings` no ACP | **rejeitado** (`flags provided but not defined`) |
| `--sandbox` padrão, sem regras | `write_file` **gravou** sem pedir permissão |
| modo `plan` | gravou `implementation_plan.md` sem pedir permissão |
| overlay privado (`--gemini-dir` + `--cli_dir_name` + `toolPermission:"strict"`) | callback para leitura, escrita e `run_command`; escrita e comando **negados**, sem canário; `.md` lido |
| fechar stdin | processo sai com código 0, nenhum `agy.exe` órfão |

Conclusão: o ACP **também corta** perto de 192 KB. O ganho vem da sessão persistente (turnos seguintes enviam só o delta) e de arquivar o histórico antigo num `.md` consultável. Logs: pasta do backup (`acp-*.log`, `acp-sqlite.log`).

## 2. Diferenças entre os modos

| | `compaction` (padrão) | `acp` (opt-in) |
|---|---|---|
| Processo | um `agy` por turno | um `agy acp` por conversa, reaproveitado |
| Envio | conversa inteira, todo turno | 1º turno/reconstrução: ≤150 KB inline + `.md`; depois só o delta |
| Acima de 180 KB | recusa e resume o histórico | não se aplica: histórico antigo vai para o `.md` |
| Permissões | `--settings` com `ROUTE_RULES` (botão `agyFix`) | overlay privado estrito sempre + callback que só libera `read_file` dentro do workspace/pasta de contexto |

## 3. Arquivos

- `lib/antigravity-acp-client.js` (novo): JSON-RPC NDJSON, exige `Antigravity ACP Server` 1.5.17 e modo `default`; `session/load` só vale com replay real; permissão só para leitura coerente (realpath, sem UNC/ADS, fora do estado privado); texto, raciocínio, uso, `max_tokens`; cancelamento e encerramento sem órfãos.
- `lib/antigravity-context-delivery.js` (novo): entrega híbrida, teto de 150.000 B, turnos inteiros, `.md` indexado (≤2 MB, ≤32 por pasta, nunca sobrescreve), alternativa se o I/O falhar, `INVALID_REQUEST` se o pedido sozinho não couber.
- `lib/antigravity-acp-transport.js` (novo): vínculo sessão DSH ↔ ACP persistido (`agy-acp/agy-acp-sessions.json`, escrita atômica), invalidação por prefixo/modelo/esforço/workspace/resposta, fallback, fixação do retry no CLI, limite de 8 processos e encerramento por ociosidade (10 min).
- `lib/antigravity-cli-local.js`: `agyTransport`/`setAgyTransport`/`onAgyTransportChange`, exports de `splitPrompt`/`renderPrompt`/`finalPrompt`/`debugLog`.
- `lib/antigravity-cli-adapter.js`: opção `stream` (gerador) e `streamCliResult`; caminho `run` intacto.
- `lib/index.js`: endpoint `setAgyTransport`, `status.agyTransport`, store inline, `apply` e ligação do transporte com descarte no unload.
- `lib/provider-settings.js` / `.d.ts`: campo `agyTransport`.
- `lib/client.js`: seletor "CLI + compaction" / "Persistent ACP" (en + zh); `agyFix` e `agyPromptGuard` só aparecem no modo compaction, com os valores preservados.
- Testes novos: `antigravity-acp-client`, `antigravity-context-delivery`, `antigravity-acp-transport`, `antigravity-acp-dsh`; `provider-settings-contract` ampliado.

## 4. Decisões

- **`agyFix` oculto no ACP**: o ACP 1.5.17 não aceita `--settings`, então o botão não teria efeito. A política lá é sempre estrita (medido).
- **`read_url` também negado no ACP** por padrão (postura mais restrita).
- **Fallback para stream-json** só com `ACP_TRANSPORT`/`TIMEOUT` **antes** do primeiro chunk. `RATE_LIMIT`, `AUTH`, `ABORTED`, `INVALID_REQUEST` e `EMPTY_RESPONSE` propagam. Depois de qualquer chunk, nunca.
- **Chamadas com `purpose`** (compactação nativa/`/compact`) vão sempre pelo CLI, sem poluir a sessão ACP.
- **Retry após `AGY_PROMPT_TOO_LARGE` no fallback**: o mesmo pedido fica fixado no CLI por 10 min, para a recuperação de 180 KB não disparar outro handshake ACP.
- **Negação sem texto**: devolve `No text response: Antigravity ACP allows only reads.` e **não** grava o vínculo (para não ressincronizar com uma resposta sintética).
- **Versão travada em 1.5.17**: outra versão cai no fallback até ser revalidada.

## 5. Testes

- `node --check`: os 9 arquivos passaram.
- Suíte offline: **153/153** passando (incluindo os testes de integração ACP + Tool Bridge).
- Runtime DSH (Electron): `antigravity-cli-overflow-dsh` 4/4; `antigravity-acp-dsh` 4/4 (histórico >500 KB com `.md` e delta, alternância ao vivo, fallback com recuperação de 180 KB, compactação nativa + reconstrução).
- Restauração do backup: 65/65 na cópia descartável.

## 6. Limitações

- Testado só com `agy` 1.5.17 no Windows; o isolamento é de configuração e callback, não de sistema operacional.
- O vínculo depende de a resposta do assistente no DSH ser igual à que o ACP gerou; qualquer diferença reconstrói a sessão (seguro, mas mais caro).
- Quota de arquivos `.md` não é coordenada entre processos distintos; os arquivos não são apagados automaticamente.
- Sem verificação visual da UI na página em execução.

## 7. Backup

`D:\Projetos\backups\spig-dsh-subscriptions-2026-11-25-150243-pre-acp\` — `repo\` (cópia completa com `.git`), `git-status.txt`, `git-diff.patch` (vazio: árvore limpa), `git-untracked.txt` (vazio), `RESTORE.md` (procedimento PowerShell 7, inclusive recriar o symlink). Restauração testada: 65/65.

## 8. Custo medido (benchmark real, histórico sintético de 240.000 B, Hydrogen Low)

| | ACP 1º turno | ACP turno seguinte | Compaction 1º turno | Compaction turno seguinte |
|---|---:|---:|---:|---:|
| Tempo | **12,4 s** | **2,4 s** | 84,9 s (42,4 s de resumo + 42,5 s de resposta) | 39,6 s |
| Bytes enviados | 121.282 (+ `.md` 124.664) | **320** | 162.243 (resumo) + 82.245 | 82.673 |
| Input / cache read | 37.669 / 60.853 | 2.412 / 31.522 | 47.022 / 0 + 33.998 / 0 | 34.138 / 0 |
| Output / raciocínio | 915 / 529 | 94 / 32 | 424 / 126 + 381 / 320 | 179 / 117 |
| Compactações | 0 | 0 | **1, causada pelo teto de 180 KB** | 0 |

As respostas foram exatas nos dois modos. No ACP, o fato mais antigo foi lido do `.md` via `read_file`. Nenhuma compactação pela janela nativa de 1M tokens ocorreu. Todos os processos encerraram (o último CLI por SIGTERM do encerramento antecipado), sem órfãos. Log: `benchmark-live-console.log` no backup.
