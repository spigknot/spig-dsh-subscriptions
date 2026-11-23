# spig-dsh-subscriptions 0.9.14-agy.1

Fork de `dsh-plugin-subscriptions@0.9.14` (MIT) que atende a rota `antigravity` pelo CLI oficial do Google (`agy`). Repositório: <https://github.com/spigknot/spig-dsh-subscriptions>.

Bundle próprio, instalado a partir de `D:\Projetos\spig-dsh-subscriptions` (`link:D:/Projetos/spig-dsh-subscriptions` em `profiles/web/package.json`).
O pacote original `dsh-plugin-subscriptions@0.9.14` continua instalado no perfil, intocado e desativado.
Os dois registram a rota `antigravity` e a página de Settings, então só um pode ficar habilitado por vez.

A rota `antigravity` é atendida pelo CLI oficial do Google (`agy`), sem depender do `dsh-agy-link`. As demais rotas continuam usando os adaptadores do upstream.

O CLI usa a conta Google logada nele no computador que executa o Harness. Execute `agy` nesse computador para entrar ou trocar de conta; confira a cota com `/usage` no CLI. O fork não importa nem transfere tokens do Subscriptions. Não há troca de conta, endpoint alternativo nem nova tentativa no Harness para contornar um erro de cota.

O catálogo é lido por `agy models`. Variantes de esforço aparecem agrupadas sob o mesmo modelo e o esforço seleciona uma variante exata do catálogo. A ponte inicial é de texto; não oferece execução de ferramentas do Harness nem processa anexos de imagem. Não é uma substituição da experiência completa do CLI em sessões de agente.

## Transporte sem argumento grande

O prompt **não** viaja em `argv`. No Windows a linha de comando tem teto de ~32 KB, e continuar uma sessão longa com `agy -p "<prompt>"` falhava com `spawn ENAMETOOLONG` antes de qualquer chamada ao modelo.

A chamada agora é:

```
agy --input-format stream-json --output-format stream-json \
    --model <variante> --settings <arquivo>
```

- O prompt vai por **stdin**, como um único turno NDJSON: `{"event":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}`. O campo `event` é obrigatório — sem ele o CLI responde `stream input message is missing the "event" field`.
- `-p='-'` **não** lê stdin: o CLI trata `-` como prompt literal vazio e abre uma conversa nova sem responder ao texto enviado. Por isso o modo print foi abandonado para o chat.
- A política de negação vai em `settings.json` dentro do diretório temporário da chamada, apagado no `finally`, em vez de JSON inline em `argv`.
- `--output-format stream-json` emite um evento por linha (`init`, `step_update`, `result`); o transporte usa o último `result`. `agy models` e `agy -p /usage` continuam no modo texto/JSON, que são pequenos.

Verificado ao vivo em `agy` 1.5.14 neste host: prompt de ~64 KB (o dobro do teto do Windows) respondido corretamente, 41 s. A suíte cobre o caso grande em `test/antigravity-cli-local.test.mjs` ("a prompt far past the Windows command-line cap is still delivered"), exigindo `argv` abaixo de 8 KB e o texto inteiro no stdin.

Cada modelo resolve `context.contextWindow` = 1.048.576 e `defaultMaxTokens` = 32.768. Sem a janela de contexto, a compactação recusa qualquer troca de modelo no meio de uma sessão com `MODEL_SWITCH_COMPACTION_FAILED`.

As barras de cota vêm do CLI, não de HTTP com token: `agy -p /usage --output-format json` devolve os buckets com `remaining_fraction`, janela (`weekly`/`5h`) e `reset_time`. O plugin converte "restante" em "usado" e alimenta os mesmos cartões de cota dos outros provedores — as três famílias (`Gemini Models`, `Claude and GPT models`, `Gemini 4 Argon`) casam com os escopos que o painel já conhece. A chamada não consome cota de modelo (`num_turns: 0`) e levava ~3,4 s.

No painel, a rota aparece conectada quando `agy models` responde — que é a prova de que o CLI está autenticado. O `status` devolve `cliManaged` (a conta é do CLI) e `cliActive` (o catálogo respondeu), além de uma linha de conta sintética `agy-cli`, porque as barras de cota são renderizadas por conta. Quando o CLI falha, a mensagem do erro vai em `detail` e aparece no cartão.

Ferramentas do próprio CLI rodam com acesso total, por decisão explícita: a política em `--settings` é `{"permissions":{"allow":["*"]}}`, verificada ao vivo no `agy` 1.5.14 (leitura por caminho absoluto e por caminho relativo ao workspace, ambas respondendo o conteúdo do arquivo). O `*` sozinho é honrado nessa versão; se um `agy` futuro passar a ignorá-lo, as leituras voltam como recusas e o ponto de ajuste é a constante `ALLOW_RULES` em `lib/antigravity-cli-local.js`.

O CLI trabalha no diretório da sessão: o plugin resolve o workspace via `ctx.get("workingDirectory")` a partir do `sessionId` da chamada (`lib/index.js`, `resolveAgyWorkspace`), passa `--add-dir <workspace>` e usa esse diretório como `cwd`, de modo que caminhos relativos resolvem no repo. Sem `sessionId` (chamadas avulsas, testes), cai para o diretório temporário da chamada. O `settings.json` continua no temporário — nunca dentro do repo — e o `finally` apaga o temporário, nunca o workspace.

Aviso: isso executa fora do sandbox e da trilha de auditoria do DSH. O `agy` executa por conta própria e devolve só o texto final — nada aparece no transcript como `tool/call`. É um agente dentro do agente, não um modelo com as ferramentas do harnês. Use só em workspaces confiáveis. As rotas OpenAI/Claude continuam sendo a opção auditável (ferramentas executadas pelo DSH, evento por evento).

A política de retry da rota é `maxRetries: 0` e sem códigos repetíveis: um 429 aparece como 429, sem laço de novas tentativas.

O teto de cada chamada é de **1 h** (`timeoutMs`, padrão do `createAgy`): revisões grandes no CLI passam fácil de 15 min, e matar no meio descarta a resposta parcial junto. Tarefa que precisa de mais que isso deve ser fatiada — o teto maior só adia o mesmo fracasso.

A metade cliente (`lib/client.js`) registra o próprio módulo com `__ModuleLoader__.load({ id: ... })`. Ao renomear o pacote, esse `id` precisa acompanhar, senão a página acusa "loaded without registering ... via __ModuleLoader__.load".

Este fork modifica os bundles publicados; não rode o build upstream sobre esta cópia sem reaplicar as mudanças.

O pacote de base é `dsh-plugin-subscriptions@0.9.14` (MIT). As mudanças locais estão em `lib/index.js`, `lib/client.js`, nos módulos `lib/antigravity-cli-*` e nos testes `test/antigravity-cli-*`. Para voltar à versão original, reinstale `dsh-plugin-subscriptions@0.9.14` pelo gerenciador do Harness.

## Credenciais OAuth do Google: removidas de propósito

O upstream embute o client ID e o client secret do aplicativo Antigravity do Google (`lib/providers/antigravity-oauth-client.*` e a cópia dentro de `lib/index.js`). São credenciais de terceiro, e o GitHub bloqueia o push de repositório que as contenha, então este fork as substituiu por strings vazias.

A rota `antigravity` **não usa** essas credenciais: a autenticação é do CLI `agy`. Elas só seriam necessárias para a rota HTTP antiga (login OAuth dentro do painel). Se um dia essa rota for reativada, defina `config.antigravity.clientId`/`clientSecret` ou as variáveis `ANTIGRAVITY_CLIENT_ID`/`ANTIGRAVITY_CLIENT_SECRET`; sem elas o código falha com uma mensagem explícita em vez de tentar um cliente incompleto.
