# Relatório — rota Antigravity respondendo a assunto anterior

**Plugin:** `spig-dsh-subscriptions` v0.9.14-agy.7 · **Repositório:** `D:\Projetos\spig-dsh-subscriptions` (base `f6b1d49`, alterações não commitadas)
**Período:** 24–25/11/2026 · **Ambiente:** DSH Desktop 0.2.2-rc.5 (perfil `web`), `agy` 1.5.16, Windows

---

## 1. Resumo executivo

| Item | Situação |
|---|---|
| Causa raiz | O plugin achatava a conversa inteira do DSH em **uma única mensagem** para o `agy`. O `agy` 1.5.16 registra a mensagem inteira, mas a representação usada na geração preserva só os primeiros **~192.000 bytes**, marca o resto `<truncated N bytes>` e ainda responde `SUCCESS`. O pedido atual fica no fim e era descartado; o modelo respondia ao último assunto visível. |
| Correção principal | Teto de **180.000 bytes** medido no texto final antes de iniciar o `agy`; acima dele nada é enviado. Se o excesso for histórico, uma recuperação própria **compacta o histórico (nunca o pedido atual)** em blocos que cabem na rota e repete o passo uma vez. |
| Correções complementares | Montagem do prompt por **origem da mensagem** (não por texto), pedido atual sempre por último, prompt de sistema rotulado como `System`, diário de depuração corrigido. |
| Configurações novas | Botão **"Avoid replies to an older topic (long prompts)"** (Antigravity, ligado por padrão); botão **"Allow fast mode (priority tier)"** (Codex, **desligado** por padrão); correção do salvamento dos botões. |
| Testes | 47 testes passando (unitários, contrato e integração com o runtime real do DSH). Uma chamada real ao Hydrogen Low (~26 mil tokens). |
| Instalação | O plugin instalado no perfil é um **link simbólico** para este repositório: os arquivos novos já estão no lugar. O DSH em execução (iniciado 24/11 22:02) **ainda não os carregou** — é preciso reiniciar o DSH. |

---

## 2. Sintoma investigado

Em sessões longas do workspace `D:\Projetos\SIG`, a rota `antigravity` respondia a um tópico antigo (ex.: instalação de APK, rodada E7 R27) em vez do pedido atual, mesmo com o pedido em texto puro no fim. O mesmo modelo por rota nativa respondia corretamente com o mesmo histórico. A falha parecia intermitente e reproduções manuais acertavam.

Hipóteses de partida (do relatório inicial): H1 metadado no fim do prompt; H2 truncamento pelo CLI; H3 excesso de contexto; H4 modelo fraco; H5 processos concorrentes; H6 turno só com anexo.

---

## 3. Investigação e evidências

### 3.1 Correlação das sessões com as trajetórias do `agy`

Para cada turno, os logs do CLI (`~/.gemini/antigravity-cli/log/cli-*.log`) foram casados por horário e modelo com os bancos de trajetória (`~/.gemini/antigravity-cli/conversations/<cascade_id>.db`, abertos somente leitura). Nas 11 trajetórias examinadas:

- a resposta mostrada no DSH foi encontrada **byte a byte** no passo de resposta do CLI;
- nos 8 turnos com pedido em texto, o **prompt completo** foi encontrado no passo de entrada do CLI.

Ou seja: o pedido **chegou** ao `agy`, e a resposta veio da trajetória daquele mesmo turno (descarta H5 para esses casos).

### 3.2 Onde o pedido se perdia

Comparando o passo de entrada com o registro de geração da mesma trajetória:

| Sessão / turno | Entrada (bytes) | Prefixo presente na geração | Cauda presente? |
|---|---:|---:|---|
| `0e41` T19 | 341.414 | 191.985 | Não |
| `0e41` T20 | 344.195 | 191.985 | Não |
| `0e41` T21 | 345.841 | 191.985 | Não |
| `0e41` T22 | 364.053 | 191.985 | Não |
| `0e41` T24–T27 | 449.583–457.232 | 191.985 | Não |
| `b598` T59 | 860.722 | 191.985 | Não |
| `7e5b` R01 (controle, acertou) | 76.367 | 76.367 | Sim |
| `7e5b` R03 (controle, acertou) | 100.853 | 100.853 | Sim |

Em todas as falhas, a geração preserva exatamente os mesmos 191.985 bytes iniciais e em seguida o marcador `<truncated N bytes>`. No T27, o pedido começava no byte 456.928 e o corte caía no meio de uma listagem de APKs — o que explica as respostas sobre APK. Um segundo especialista confirmou o padrão em 20 trajetórias truncadas (todas a partir de ~206 KB, nenhuma até ~183 KB) e localizou o literal `<truncated %d bytes>` dentro do `agy.exe`.

### 3.3 Experimentos que separam truncamento de deriva

| Experimento | Resultado |
|---|---|
| Hydrogen Low, instrução no início, segredo no fim, 2 KB de enchimento | início e fim recuperados |
| Mesmo, 204.800 bytes de enchimento | início recuperado, fim **ausente** (`TAIL=ABSENT`), `SUCCESS` |
| (segundo especialista) linhas numeradas, 260 KB | última linha vista ≈ 192.000 bytes; tokens de entrada só cresceram com as linhas visíveis |
| Prompt de **exatamente 180.000 bytes** pela rota corrigida | início e fim recuperados; registro de geração **sem** marcador de corte (26.211 tokens de entrada) |
| Prompt de 180.001 bytes pela rota corrigida | recusado **antes** de iniciar o `agy` (`spawned: 0`) |

### 3.4 Situação das demais hipóteses

| Hipótese | Conclusão |
|---|---|
| H1 — metadado no fim | Não era a causa desses incidentes: pedido e metadado estavam ambos depois do corte. |
| H2 — truncamento | **Causa principal**, demonstrada nos registros e reproduzida. |
| H3 — histórico grande | Condição criada pelo achatamento em uma mensagem; o DSH entrega o histórico já derivado (com checkpoints), o plugin não relia o JSONL bruto. |
| H4 — modelo fraco | Descartada: mesmo corte em Gemini e Claude pela rota CLI. |
| H5 — processos concorrentes | Desfavorecida: cada resposta pertence à trajetória do próprio turno; teste local com dois prompts de 450 KB simultâneos não cruzou resultados. |
| H6 — turno só com anexo | Contradição resolvida no código do DSH: antes do envio, todo bloco `file` vira uma **referência textual** (nome, tamanho, hash, caminho), não o conteúdo. Nos controles R01/R03 o próprio `agy` leu o arquivo (`read_file`); no T59 o nome chegou, mas nenhuma linha do relatório foi lida. |

### 3.5 Problemas encontrados nas correções anteriores

- **`6c1160d` (filtro `META_TURN`)**: aplicava uma regex sobre o texto **juntado** da mensagem; uma mensagem cujo primeiro bloco começasse com `<system-reminder>` era descartada inteira, **inclusive o pedido real**.
- **`f6b1d49` ("termina em user")**: a verificação passava quando sobrava um pedido **antigo** do usuário; também aceitava pedido só com espaços.
- **Diário `DSH_AGY_DEBUG`**: não registrava falhas da montagem do prompt e media a resposta em unidades UTF-16, não em bytes.
- **Recuperação padrão do DSH (`compaction-basic`)**: no caminho de *context overflow* mantém apenas o último nó da sessão. Como o DSH admite contexto de runtime **depois** do pedido, o pedido poderia ir para o resumo. Além disso, o resumo também passa pelo `agy`, e um histórico de 300–450 KB não cabe numa só chamada.
- **Salvamento do botão "empty replies"**: fazia `{ ...providerSettings.get(...) }`, mas `get` é assíncrono — o primeiro desligamento gravaria só `{agyFix}` e **apagaria** nome de exibição e modelos visíveis do Antigravity (não chegou a acontecer: o botão nunca foi desligado).

---

## 4. Correções feitas

### 4.1 Teto de bytes no transporte — `lib/antigravity-cli-local.js`

- `MAX_AGY_PROMPT_BYTES = 180_000`: margem abaixo do corte observado no `agy` 1.5.16 (não é limite documentado nem janela de tokens).
- O texto **final** (nota da rota + prompt) é medido com `Buffer.byteLength(..., 'utf8')` antes de criar o processo. Acima do teto nada é enviado nem cortado. Três casos:
  - excesso causado pelo **histórico** → código próprio `ANTIGRAVITY_PROMPT_TOO_LARGE` (deliberadamente diferente do `CONTEXT_WINDOW_EXCEEDED` do DSH, para a recuperação padrão não agir);
  - o **pedido atual com instruções** já não cabe → `INVALID_REQUEST` com explicação (compactar não ajudaria);
  - a **chamada de resumo** não cabe → `INVALID_REQUEST`, sem laço.
- Só vale para chamadas que vão ao `agy`; as outras rotas não são afetadas.

### 4.2 Montagem do prompt por origem — mesmo arquivo

- Substitui a regex de `6c1160d` e a regra de `f6b1d49`.
- Mensagens `user` são classificadas pelo `source.kind` que o DSH grava: `runtime-context`, `time-context`, `model-selection`, `agent-instructions`, `skill-catalog`, `skill-invocation` e `compact-checkpoint` são **contexto**; o resto (pessoa, retry, objetivo, subagente, agenda, instrução auxiliar) é **pedido**.
- O "trecho ativo" é tudo depois da última resposta do assistente. Nele, o contexto vai **antes** e o pedido **por último**.
- Texto digitado pela pessoa nunca é descartado por começar com `<system-reminder>`.
- Pedido vazio → erro explícito. "Continuar" (retry vazio) vira instrução explícita de retomada. Resultados de ferramenta sem pedido novo viram instrução de continuação. Só contexto depois da última resposta → erro, nunca resposta ao histórico.
- Prompt de sistema do DSH passa a ser rotulado `System:` (antes saía como `User:`).
- Diário: falhas de montagem passam a ser registradas; tamanho da resposta em bytes; inclui `purpose` e estado da proteção.

### 4.3 Recuperação própria — `lib/antigravity-cli-recovery.js` (novo), ligada em `lib/index.js`

- Ouve `agent/request-error` com `prepend`, apenas para provedor `antigravity` e código `ANTIGRAVITY_PROMPT_TOO_LARGE`; tudo o mais segue para `next()`.
- Usa o serviço de compactação do **próprio agente** (`agentPresets.serviceFor(agent, 'compaction')`, com alternativa `ctx.get('compaction')`).
- Escolhe blocos do histórico do mais antigo ao mais novo, cada um com prompt de resumo estimado dentro do teto; nunca inclui o trecho ativo e nunca separa uma chamada de ferramenta do seu resultado.
- Repete até o histórico caber (máx. 8 resumos), verificando a cada rodada que o pedido atual continua intacto e que o tamanho caiu.
- Pede **uma** nova tentativa do passo; uma segunda recusa no mesmo passo é terminal (sem laço). Falhas viram aviso no log com o motivo.

### 4.4 Botões de configuração (vacinas) — `lib/index.js`, `lib/client.js`, `lib/provider-settings.*`

| Botão | Onde | Padrão | Efeito |
|---|---|---|---|
| Avoid empty replies (shell off) | Antigravity | ligado | (já existia) nega comandos/escrita ao `agy`; o salvamento agora preserva os demais ajustes |
| **Avoid replies to an older topic (long prompts)** | Antigravity | **ligado** | liga o teto de 180 KB e a compactação; desligado = comportamento antigo (envia tudo) |
| **Allow fast mode (priority tier)** | Codex | **desligado** | ver 4.5 |

Novos endpoints RPC `setAgyPromptGuard` e `setCodexFast`; os três botões gravam via `patch`, que mescla com o documento salvo em vez de substituí-lo. A montagem do prompt (4.2) não é desligável: corrige erros sem efeito colateral.

### 4.5 Modo rápido do Codex — `lib/index.js`

Verificação: o único ponto que escreve `service_tier: priority` é o corpo da requisição do Codex, controlado por `speedFor`. No perfil não havia `model-speeds.json` nem velocidade de subagente salva; não foi encontrado indício de uso do modo rápido (a escolha por sessão em memória não deixa registro). O e-mail da OpenAI cita correção também em requisições comuns, o que tende a explicar o fim da cota.

Bloqueio aplicado enquanto o botão estiver desligado:
1. `speedFor` exige `preferences.codexFastAllowed()` — nenhuma requisição leva o campo;
2. `speed()` devolve `standard` e nenhum modelo rápido — o seletor de velocidade some do compositor;
3. `setSpeed('fast')` é recusado;
4. o catálogo de configurações não oferece "fast" a subagentes.

### 4.6 Avaliação do botão "empty replies"

Mantido ligado. É uma contenção, não a correção da causa: o executor de comandos do `agy` falha com `0xC0000142` quando iniciado pelo DSH, e negar `command` faz o modelo responder em texto em vez de insistir. A perda prática é pequena: a rota já não chama ferramentas do DSH. A correção de causa exigiria fazer o executor do `agy` funcionar quando iniciado pelo DSH, o que não foi resolvido.

---

## 5. Testes e validação

| Suíte | O que cobre |
|---|---|
| `test/antigravity-cli-local.test.mjs` | teto (vermelho antes da correção), limite exato de 180.000 bytes, casos `INVALID_REQUEST`, montagem por origem, retry, ferramenta, anexo, proteção desligada |
| `test/antigravity-cli-recovery.test.mjs` | histórico de 450 KB compactado em vários blocos, cada um dentro do teto, sem tocar no pedido; fronteira de ferramenta; mensagem única grande demais; escopo do listener |
| `test/antigravity-cli-overflow-dsh.test.mjs` | turno completo no **runtime real do DSH** (loop de agente, sessão, `compaction-basic`) com `agy` simulado que só vê 192 KB; com e sem contexto de runtime depois do pedido |
| `test/provider-settings-contract.test.mjs` | padrões dos botões, todos os caminhos do modo rápido passando pelo bloqueio, botões mesclando em vez de substituir |

Prova de que o teste de integração detecta o defeito:
- **código original (`f6b1d49`)**: falha — enviou 182.897 bytes ao CLI;
- **correção usando a recuperação padrão do DSH**: falha no caso com contexto depois do pedido (o resumo incluiria o pedido e não cabia);
- **correção final**: passa nos dois cenários.

Resultado final: **47/47 testes passando**; `node --check` sem erros em `index.js`, `client.js`, `antigravity-cli-local.js` e `provider-settings.js`.

Observação: os testes do módulo de recuperação e dos botões foram escritos depois do código; para a recuperação, a evidência de detecção vem do teste de integração acima. Os testes dos botões no lado do host são verificações estáticas do pacote, porque `lib/index.js` só carrega dentro do DSH.

---

## 6. Estado da instalação no plugin `spig-dsh-subscriptions`

- O perfil `web` carrega o plugin por `C:\Users\Gustavo\.dsh\profiles\web\node_modules\spig-dsh-subscriptions`, que é um **link simbólico** para `D:\Projetos\spig-dsh-subscriptions`. Conferido: `lib/antigravity-cli-recovery.js` existe pelo caminho do perfil e `lib/antigravity-cli-local.js` é idêntico (mesmo hash) ao do repositório.
- Portanto as correções **já estão instaladas** nos arquivos do plugin, sem reinstalação.
- **Ativação:** o processo do DSH em execução foi iniciado em 24/11/2026 22:02, antes das edições, e mantém o código antigo em memória. As correções passam a valer **após reiniciar o DSH**.
- Nada foi commitado nem publicado. Arquivos alterados: `lib/antigravity-cli-local.js`, `lib/index.js`, `lib/client.js`, `lib/provider-settings.js`, `lib/provider-settings.d.ts`, `test/antigravity-cli-local.test.mjs`, `test/provider-settings-contract.test.mjs`. Novos: `lib/antigravity-cli-recovery.js`, `test/antigravity-cli-recovery.test.mjs`, `test/antigravity-cli-overflow-dsh.test.mjs`, este relatório.
- Nenhuma configuração do perfil foi alterada.

---

## 7. Comportamento esperado após reiniciar

- Ao trocar para um modelo do Antigravity numa conversa longa, a compactação **não** ocorre na troca; ocorre no primeiro envio, se o prompt passar de 180 KB.
- Para ~450 KB: cerca de 3 resumos pelo próprio `agy` (estimativa de 150–250 mil tokens de entrada de uma vez, 1–3 min a mais). Depois, um resumo a cada vez que o histórico voltar a 180 KB.
- O resumo fica na sessão: outras rotas passam a ver o resumo, não o histórico completo (o log original permanece salvo).
- Cache: as sessões existentes mostram ~79% do input vindo de cache na rota Antigravity (41,9 M de 53,3 M). Cada compactação causa uma perda de cache única; a primeira chamada após a atualização também, pela mudança de formato.

---

## 8. Limitações e próximos passos

- O teto de 180 KB é empírico para o `agy` 1.5.16; deve ser medido de novo a cada atualização do `agy`.
- Se uma única mensagem antiga tiver mais de ~170 KB, ela não pode ser resumida por esta rota; o turno falha com explicação. Alternativa: configurar o sumarizador da compactação para outra rota (mudança de perfil, não feita).
- Ainda não houve validação numa conversa real da GUI. Sugestão: definir `DSH_AGY_DEBUG=1`, reiniciar o DSH e acompanhar `%TEMP%\dsh-agy-debug.log` (`promptBytes`, `guard`, `purpose`, falhas).
- A causa do `0xC0000142` (executor de comandos do `agy` sob o DSH) segue sem solução.
- A conversa contínua no Antigravity (processo persistente por sessão) foi avaliada e deixada para depois: o ganho de cache seria pequeno e o risco de novos defeitos é alto.
