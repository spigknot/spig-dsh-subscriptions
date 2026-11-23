# spig-dsh-subscriptions 0.9.14-agy.1

Fork de `dsh-plugin-subscriptions@0.9.14` (MIT) que atende a rota `antigravity` pelo CLI oficial do Google (`agy`). Repositório: <https://github.com/spigknot/spig-dsh-subscriptions>.

Bundle próprio, instalado a partir de `D:\Projetos\spig-dsh-subscriptions` (`link:D:/Projetos/spig-dsh-subscriptions` em `profiles/web/package.json`).
O pacote original `dsh-plugin-subscriptions@0.9.14` continua instalado no perfil, intocado e desativado.
Os dois registram a rota `antigravity` e a página de Settings, então só um pode ficar habilitado por vez.

A rota `antigravity` é atendida pelo CLI oficial do Google (`agy`), sem depender do `dsh-agy-link`. As demais rotas continuam usando os adaptadores do upstream.

O CLI usa a conta Google logada nele no computador que executa o Harness. Execute `agy` nesse computador para entrar ou trocar de conta; confira a cota com `/usage` no CLI. O fork não importa nem transfere tokens do Subscriptions. Não há troca de conta, endpoint alternativo nem nova tentativa no Harness para contornar um erro de cota.

O catálogo é lido por `agy models`. Variantes de esforço aparecem agrupadas sob o mesmo modelo e o esforço seleciona uma variante exata do catálogo. A ponte inicial é de texto; não oferece execução de ferramentas do Harness nem processa anexos de imagem. Não é uma substituição da experiência completa do CLI em sessões de agente.

Cada modelo resolve `context.contextWindow` = 1.048.576 e `defaultMaxTokens` = 32.768. Sem a janela de contexto, a compactação recusa qualquer troca de modelo no meio de uma sessão com `MODEL_SWITCH_COMPACTION_FAILED`.

As barras de cota vêm do CLI, não de HTTP com token: `agy -p /usage --output-format json` devolve os buckets com `remaining_fraction`, janela (`weekly`/`5h`) e `reset_time`. O plugin converte "restante" em "usado" e alimenta os mesmos cartões de cota dos outros provedores — as três famílias (`Gemini Models`, `Claude and GPT models`, `Gemini 4 Argon`) casam com os escopos que o painel já conhece. A chamada não consome cota de modelo (`num_turns: 0`) e levava ~3,4 s.

No painel, a rota aparece conectada quando `agy models` responde — que é a prova de que o CLI está autenticado. O `status` devolve `cliManaged` (a conta é do CLI) e `cliActive` (o catálogo respondeu), além de uma linha de conta sintética `agy-cli`, porque as barras de cota são renderizadas por conta. Quando o CLI falha, a mensagem do erro vai em `detail` e aparece no cartão.

Ferramentas do próprio CLI são bloqueadas na camada de política dele. O motor de permissões tem exatamente sete ações (`read_file`, `write_file`, `read_url`, `execute_url`, `download_url`, `command`, `mcp`) e **não** tem curinga global: uma regra não reconhecida — como um `*` sozinho — é ignorada em silêncio. Por isso as sete são negadas explicitamente em `--settings`, cada uma como `acao(*)`.

Verificado ao vivo no `agy` 1.5.14 deste host, com essas regras: pedido para listar `C:\Windows` → `BLOCKED`; pedido para buscar uma URL imprevisível (`random.org` com `rnd=new`) → `BLOCKED`; pedido para rodar `echo hello` → `BLOCKED`; escrita fora do diretório da sessão não criou arquivo. O bloqueio acontece antes da execução.

Risco residual conhecido: ferramentas que não são recursos de permissão — por exemplo geração de imagem, subagentes, execução de notebook e agendamento — não são cobertas por nenhuma dessas sete regras, e não foram verificadas uma a uma.

A política de retry da rota é `maxRetries: 0` e sem códigos repetíveis: um 429 aparece como 429, sem laço de novas tentativas.

A metade cliente (`lib/client.js`) registra o próprio módulo com `__ModuleLoader__.load({ id: ... })`. Ao renomear o pacote, esse `id` precisa acompanhar, senão a página acusa "loaded without registering ... via __ModuleLoader__.load".

Este fork modifica os bundles publicados; não rode o build upstream sobre esta cópia sem reaplicar as mudanças.

O pacote de base é `dsh-plugin-subscriptions@0.9.14` (MIT). As mudanças locais estão em `lib/index.js`, `lib/client.js`, nos módulos `lib/antigravity-cli-*` e nos testes `test/antigravity-cli-*`. Para voltar à versão original, reinstale `dsh-plugin-subscriptions@0.9.14` pelo gerenciador do Harness.

## Credenciais OAuth do Google: removidas de propósito

O upstream embute o client ID e o client secret do aplicativo Antigravity do Google (`lib/providers/antigravity-oauth-client.*` e a cópia dentro de `lib/index.js`). São credenciais de terceiro, e o GitHub bloqueia o push de repositório que as contenha, então este fork as substituiu por strings vazias.

A rota `antigravity` **não usa** essas credenciais: a autenticação é do CLI `agy`. Elas só seriam necessárias para a rota HTTP antiga (login OAuth dentro do painel). Se um dia essa rota for reativada, defina `config.antigravity.clientId`/`clientSecret` ou as variáveis `ANTIGRAVITY_CLIENT_ID`/`ANTIGRAVITY_CLIENT_SECRET`; sem elas o código falha com uma mensagem explícita em vez de tentar um cliente incompleto.
