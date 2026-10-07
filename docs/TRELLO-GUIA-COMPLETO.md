# 🎯 Tutorial completo: configurar o Trello no Trello Orbit

> **Guia passo a passo, com links e comandos copiáveis** — do zero até o teu board real aparecer
> no app. Baseado em pesquisa profunda (3 rondas, 58 fontes, verificação adversarial) em **outubro
> de 2026**. O dossiê de evidência está em [`pesquisas/trello-setup-api.md`](../pesquisas/trello-setup-api.md).

---

## Em 60 segundos

Precisas de **três valores**, todos gerados por ti no site do Trello, e de os colocar **um ficheiro** (`.env`):

| Valor | Variável | De onde vem | Tempo |
|---|---|---|---|
| **API key** (identifica a app) | `TRELLO_API_KEY` | App Admin Portal → tua app → **Generate a new API Key** | 3 min |
| **Token** (age como TU na conta) | `TRELLO_API_TOKEN` | Mesma página → link **Token** → **Allow** | 1 min |
| **ID do board** (qual board controlar) | `TRELLO_BOARD_ID` | `curl` ao final deste guia, ou código do URL do board | 1 min |

Depois: `npm start` em `server/` → o selo «modo demo» desaparece do cabeçalho do app. ✔

> **Ordem importa:** key primeiro (a key só existe dentro de uma app registada), token depois
> (o token é gerado *para* aquela key), board id por último.

---

## Mapa mental: o que é cada coisa

```
A tua conta Trello
 └── App (crias no portal) ── tem 1 API KEY (pode ser pública)
      └── TOKEN ── gerado com essa key, com escopo + expiração
           │         • representa A TI (não a app)
           │         • dá acesso a TODOS os teus boards
           │         • é SECRETO — nunca commitar, nunca partilhar
           └── usado em cada chamada: ?key=…&token=…  (ou header Authorization)
```

- **Key** = "quem é a aplicação". Sozinha não acede a nada.
- **Token** = "o que a aplicação pode fazer em teu nome". É o segredo a sério.
- **Board ID** = o alvo. Pode ser o id de 24 caracteres **ou** o `shortLink` (código de 8
  caracteres do URL `trello.com/b/<código>`) — este serve no *path* dos endpoints; para o `.env`
  usa o que obtiveres no passo 4 (o id longo é o mais seguro).

---

## Antes de começar

- [ ] Conta Trello (o plano **grátis chega** — sem plano pago, sem revisão, sem publicar nada).
- [ ] Sessão iniciada no browser.
- [ ] **Sê admin de pelo menos um Workspace** (antigamente "team") — o portal só lista Workspaces
      de que és admin. Sem nenhum? Cria um em <https://trello.com/admin> (grátis).
- [ ] O projeto **Trello Orbit** clonado e as dependências instaladas (`npm install` em `server/`
      e `web/`).

---

## Passo 1 — Abrir o portal e criar a app (3 minutos)

1. Abre **<https://trello.com/apps/admin>** *(o URL canónico na documentação oficial de 2026; a
   forma antiga `trello.com/power-ups/admin` ainda aparece em guias antigos e provavelmente
   redireciona — se um não abrir, usa o outro)*.
2. Na **primeira visita**, aceita o **Joint Development Agreement** (é só um formulário; não te
   obriga a publicar nada).
3. Clica em **"New"** (canto superior direito).
4. Preenche:
   - **Name** — o que quiseres, ex.: `Trello Orbit`;
   - **Workspace** — escolhe um Workspace onde **és admin**;
   - Email / Support email / Author — os teus contactos;
   - **"My app will/doesn't use Power-up capabilities"** → escolhe **"My app doesn't use Power-Up
     capabilities"**. Só com esta escolha é que **o campo Iframe Connector URL desaparece** — a
     documentação oficial é literal: *"If you select 'My app doesn't use Power-Up capabilities',
     your app will not need an Iframe Connector URL… you will not have the option to fill in this
     field"*. Se escolheres a outra opção, o iframe passa a ser obrigatório (é para apps que
     carregam uma interface dentro do Trello — **não é o teu caso**).
   - Email / Support email / Author — os teus contactos.
   - **Iframe Connector URL** — se este campo aparecer a pedir valor, é porque ficaste na opção
     "will use Power-Up capabilities": volta atrás e muda para *doesn't use*. Se a tua UI não
     deixar mudar depois de criada, cria a app de novo com a opção certa. (Em último recurso, um
     placeholder válido como `https://localhost` não faz mal nenhum: o campo só é usado se a app
     for carregada como Power-Up dentro de um board — o que nunca acontece neste projeto.)
5. Clica **"Create"**. Ficas na página de definições da app.

> **Não precisas de:** publicar o Power-Up, ativar capabilities, plano pago, nem submeter nada a
> revisão. Staff da Atlassian confirma: a app não precisa de ser pública para a key ser usada.

## Passo 2 — Gerar a API key (1 minuto)

1. Na página da tua app, abre a aba de autorização. **O nome da aba varia**:
   a documentação mais recente chama-lhe **"Trello Auth"**; noutros sítios (e em apps antigos)
   aparece **"API Key"**. É a mesma aba — segue o que aparecer no teu ecrã.
2. Clica **"Generate a new API Key"**. Se pedir confirmação, confirma.
3. Aparecem dois valores: a **API key** e o **API secret**.
   - Copia a **API key** → vai para `TRELLO_API_KEY`.
   - **⚠ Não confundas:** o **API secret NÃO é o token**. (É o erro nº1 das pessoas —
     "estava a usar o Secret em vez do Token".)

```bash
# exemplo de formato (NÃO uses estes valores!)
TRELLO_API_KEY=1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d
```

## Passo 3 — Gerar o token (2 minutos)

1. **Na mesma página**, ao lado da API key há a palavra **"Token"** hiperligada — clica-a.
2. Abre-se a página de autorização. Confere o que ela diz (mostra a que conta o token acede e o
   escopo) e clica **"Allow"**.
3. Aparece uma **página com o teu token** (uma cadeia longa — tokens antigos têm 64 caracteres
   hexadecimais; tokens novos começam por `ATTA`). Copia **tudo**.
4. Cola em `TRELLO_API_TOKEN`.

**Cuidados que evitam 90% dos `invalid token`:**

- Não coloques o **API secret** (Passo 2) — não é o token.
- Não fiquem **espaços, aspas ou quebras de linha** antes/depois do valor no `.env`.
- Não deixes os **`{ }`** de exemplos/copy-paste de placeholders.
- O token da key A **não funciona** com a key B — gera o token a partir da *tua* app.
- Sobre `#token=` na URL: **não se aplica ao teu caso**. O fragmento `#token=…` só aparece em
  apps que pedem `callback_method=fragment`; pelo caminho normal (link "Token" → "Allow") o token
  simplesmente aparece numa página.

**Alternativa avançada (recomendada se quiseres controlo fino):** em vez do link "Token", podes
montar o URL de autorização à mão e escolher escopo e expiração explicitamente:

```
https://trello.com/1/authorize?response_type=token&key=TUA_KEY&scope=read,write&expiration=never&name=Trello%20Orbit
```

- `scope=read,write` — **é tudo o que o Trello Orbit precisa** (ler boards, criar/mover/apagar
  cards, comentários). `account` só é preciso para ler o teu email — **não peças** (menor
  privilégio).
- `expiration` — **define sempre explicitamente**: `never` para uso em servidor (guarda o token
  como segredo e revoga quando quiseres), `30days`/`1day`/`1hour` para testes. **Os valores por
  omissão divergem entre as páginas oficiais** (uma diz `30days`, outra `never`) — não confies na
  omissão. A expiração fixa-se na geração e não muda depois (para mudar, geras outro token).

## Passo 4 — Descobrir o ID do board (2 minutos)

Qualquer um destes métodos funciona:

**Método A — pelo próprio app (o mais fácil, depois do Passo 5 com key+token):**

```bash
curl -s "http://localhost:8787/api/trello/boards"
# → [{"id":"<AQUI>","name":"Meu Board","url":"…"}]
```

**Método B — direto na API do Trello** (com a key e o token já em mãos):

```bash
curl -s "https://api.trello.com/1/members/me/boards?key=TUA_KEY&token=TU_TOKEN&fields=name,url"
```

Exemplo de resposta (o `id` vem **sempre**, mesmo que peças só `name` e `url`):

```json
[{"id":"5f8a2b1c9d8e7f6a5b4c3d2e","name":"Meu Board","url":"https://trello.com/b/AbCdEfGh/meu-board"}]
```

**Método C — pelo URL do board (sem API):** abre o board; o URL tem o formato
`trello.com/b/<código>/<nome>`. O `<código>` de 8 caracteres (**shortLink**) **é aceite** pela API
no lugar do id longo — funciona no `TRELLO_BOARD_ID` e o projeto resolve-o para o id canónico
automaticamente. Se preferires o id longo, usa o Método A/B.

> **⚠ Ressalvas importantes:**
> - `GET /1/members/me/boards` **não mostra boards arquivados/fechados** por omissão. Se o teu
>   board não aparecer: reabre-o no Trello, ou usa o Método C (o shortLink continua a valer).
> - Não confundas **board id** com **Workspace id** (`idOrganization`) — o board id tem 24
>   caracteres ou é o código do URL `trello.com/b/…`.

## Passo 5 — Preencher o `.env` do projeto (2 minutos)

```bash
cd trello-assistant
cp .env.example .env        # se ainda não existir
chmod 600 .env              # só tu lês (boa prática OWASP)
```

Edita o `.env`:

```ini
TRELLO_API_KEY=1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d
TRELLO_API_TOKEN=ATTAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TRELLO_BOARD_ID=AbCdEfGh
```

- Sem aspas, sem espaços à volta do `=`.
- O `.env` **já está no `.gitignore`** — nunca entra no git. (Se algum dia o commitares por
  engano: **revoga as credenciais imediatamente** nos painéis e gera novas; apagar o ficheiro não
  chega.)
- Os outros campos (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`) podem ficar em branco — o app funciona
  em modo degradado até os preencheres.

## Passo 6 — Validar que SAÍSTE do modo demo (2 minutos)

```bash
cd server && npm start
```

1. **Pela API:**
   ```bash
   curl -s http://localhost:8787/api/status
   ```
   Esperado: `"board":"trello"` (e não `"demo"`), `"boardName":"<nome do teu board>"`, `"missing":[]`.
2. **Pelo app:** abre <http://localhost:8787> — o selo **«modo demo»** desaparece do cabeçalho e os
   cards da órbita são os do **teu** board.
3. **Prova de vida por voz:** fala *"cria um card chamado teste de órbita na lista a fazer"* →
   confirma → o card aparece no Trello real (abre o board no browser para veres). Depois
   *"apaga o card teste de órbita"* → confirma com o botão de segurar.

✔ Se tudo isto passou: **está configurado**.

---

## Autenticação: como cada chamada é feita

A API aceita a dupla key+token de **três formas** (todas oficiais):

```bash
# 1) Query string — a mais simples (é o que o projeto usa)
curl -s "https://api.trello.com/1/members/me?key=TUA_KEY&token=TU_TOKEN"

# 2) Header Authorization — recomendado pela OWASP (evita credenciais em URLs/logs)
curl -s -H 'Authorization: OAuth oauth_consumer_key="TUA_KEY", oauth_token="TU_TOKEN"' \
     "https://api.trello.com/1/members/me"

# 3) Corpo do pedido (PUT/POST) — pares chave-valor, NÃO JSON
curl -s -X POST "https://api.trello.com/1/cards" \
     -H "Content-Type: application/x-www-form-urlencoded" \
     -d "key=TUA_KEY&token=TU_TOKEN&idList=ID_DA_LISTA&name=Novo%20card"
```

**Porque a query string é aceitável aqui:** as chamadas saem do **servidor** do Trello Orbit (as
chaves nunca chegam ao browser nem a URLs partilhados). Ainda assim, a boa prática OWASP é
preferir o header (`CWE-598`: URLs aparecem em logs, `Referer`, histórico). O `server/` usa query
string por simplicidade — se quiseres endurecer, o header acima é "drop-in".

**Teste de saúde das credenciais** (o único "verificador" que existe):

```bash
curl -s "https://api.trello.com/1/members/me?key=TUA_KEY&token=TU_TOKEN"
# ✅ 200 → JSON com o teu id, username, etc.
# ❌ 401 "invalid token" → token errado/expirado/revogado (ver Troubleshooting)
```

---

## Limites de uso (para não levar 429)

| Limite | Valor oficial |
|---|---|
| Por **API key** | 300 pedidos / 10 segundos |
| Por **token** | 100 pedidos / 10 segundos |
| Rotas especiais `/1/members`, `/1/membersSearch`, `/1/search` | 100 pedidos / 900 segundos |
| Erros 429 consecutivos por key | **> 200 bloqueia a key pelo resto da janela de 10 s** |
| Limite por IP e de base de dados | existem, **sem números publicados** (cuidado em IP partilhado/serverless) |

- **Headers em todas as respostas:** `x-rate-limit-api-key-{interval-ms,max,remaining}` e
  `x-rate-limit-api-token-{interval-ms,max,remaining}` — dá para monitorizar antes de estourar.
- **Ao exceder:** HTTP **429** com corpo JSON (`error`: `API_TOKEN_LIMIT_EXCEEDED`,
  `API_KEY_LIMIT_EXCEEDED`, … — atenção: **não é um conjunto fechado** de códigos).
- **`Retry-After` não está documentado para o Trello** (a página de rate limits não o menciona).
  A mitigação oficial é: reduzir polling, agrupar chamadas, migrar para **webhooks**. O
  Trello Orbit pede poucas chamadas por comando de voz (1–3), portanto **não deverás ver 429**;
  mesmo assim, o servidor já aplica backoff com jitter (e honra `Retry-After` se algum dia vier).
- Os webhooks têm backoff documentado (30 s → 60 s → 120 s) e são desativados automaticamente
  após 30 dias com mais de 1000 falhas seguidas.

---

## Segurança — a parte a sério

| Regra | Porquê |
|---|---|
| **O token NUNCA vai para o git, para o browser ou para logs** | O token dá acesso a **toda a tua conta Trello** — todos os boards, não só este. A própria Atlassian: "a token should never be publicly available. If a token becomes public, it should be revoked immediately". |
| A key pode ser pública | Não dá acesso a dados sozinha. Mas guarda-a à mesma. |
| Escopo mínimo: `read,write` | Não peças `account` (só serve para email). Não há escopos por board no fluxo clássico. |
| `expiration=never` + cofre de segredos | Se usares `never`, trata o token como password: `.env` com `chmod 600`, em produção um secrets manager. |
| `.env` no `.gitignore` | Já está. Confirma com `git status` antes de cada commit. |
| HTTPS em produção | Sem TLS o browser não libera o microfone e as credenciais viajam expostas. |

**Queres limitar o estrago? (recomendado para equipas)** cria uma **conta de serviço**: um
utilizador Trello dedicado (ex.: `trello-orbit-bot@…`) convidado **só a esse board** com permissão
Normal, e gera key+token dessa conta. Se o token vazar, o atacante só vê esse board.

**Plano de incidente (se o token vazar):** 1) `Account Settings → Applications → Revoke`
(imediato); 2) gera token novo; 3) revê o histórico de atividade do board; 4) se a **key** também
vazou, regenera-a na app do portal (o token antigo fica inválido com a key nova).

---

## Manutenção e futuro

- **Revogar token:** <https://trello.com/u/my/account> → secção **Applications** → **Revoke**
  (ou `DELETE /1/tokens/{token}` via API). Depois disso, a app recebe `401 invalid token` — o
  Trello Orbit trata qualquer 401 como pedido de nova autorização.
- **Token expirado** (se usaste `30days` etc.): mesmo sintoma (`401 invalid token`) — repete o
  Passo 3. A expiração não se edita; gera-se outro token.
- **Key perdida/comprometida:** regenera na app do portal; atualiza `TRELLO_API_KEY` e **refaz o
  Passo 3** (o token é atrelado à key).
- **Apagar a app antiga:** no portal, na app → opções → delete. Credenciais dessa app morrem.
- **OAuth 2.0 (no horizonte):** desde 15/09/2026 o Trello oferece OAuth 2.0 3LO (tokens curtos:
  access 1 h + refresh 90 d, escopos granulares). É **opcional** — o fluxo key+token **não tem
  prazo de depreciação anunciado** (a Atlassian promete ≥ 6 meses de aviso), mas admite que a
  depreciação "eventual" é provável. Quando chegarem mais perto, o projeto migra; hoje, key+token
  é o caminho simples e oficialmente suportado.

---

## 🔧 Troubleshooting (diagnóstico por ordem)

**Ordem certa (importante!): o Trello valida o id ANTES da autenticação** (ticket oficial
TRELLO-1770) — um `400` aparece mesmo com token inválido. Por isso: **primeiro confere 400/ids,
depois credenciais.**

```
1. curl /1/members/me?key=…&token=…      → 200? Credenciais OK.
2. 400?  → problema de formato/id (ver tabela) — o token pode estar bom.
3. 401?  → credenciais (ver tabela) — testa key e token em separado.
4. 404?  → URL mal formada ou recurso inexistente.
```

| Sintoma | Causa provável | Correção |
|---|---|---|
| `400` com corpo `invalid value for name` (texto simples, não JSON) | Parâmetros enviados como **JSON**; o Trello quer query string ou `x-www-form-urlencoded` | Reenvia como no exemplo "3) Corpo do pedido" |
| `400` com `invalid value for idList` | `idList` inexistente, de outro board, ou colaste um board/card id no lugar do list id | Obtém os ids: `curl "…/1/boards/ID_BOARD/lists?key=…&token=…"` |
| `400` com `invalid id` / `Invalid objectId` | **shortLink em parâmetro de corpo** (ou id malformado) | Usa o id de 24 caracteres no corpo (o shortLink só no path) |
| `401` com `invalid token` | Token errado, truncado, expirado ou revogado — **ou não enviaste nada** (a API não distingue) | Repete o Passo 3; confere que não colaste o *secret*; valida com `/1/members/me` |
| `401` com `invalid key` | Key errada — **mas cuidado**: casos reais eram tokens inválidos com esta mensagem | Testa key e token em separado; regenera o que falhar |
| `401` com `missing scopes` (POST) | Mensagem **enganadora**: quase sempre falta o **token** no pedido (ticket TRELLO-1769) | Adiciona o token ao pedido |
| `401` com `unauthorized permission requested` | Escopo insuficiente (falta `write`) **ou** o membro não pode escrever no board (ex.: Observer) | Regenera token com `read,write`; confirma a tua permissão no board (mínimo Normal) |
| `403` | Recusa contextual, **não é credencial**: ex. recurso que exige Power-Up ativado no board | Lê a mensagem do corpo — diz exatamente o que falta |
| `404` | Rota/modelo inexistente **ou URL mal formada** (`&key=` em vez de `?key=` → 404!) | Confere o `?` antes da query; confirma o id |
| Board "não aparece" na lista | Boards arquivados/fechados ficam de fora por omissão | Reabre o board; ou usa o shortLink do URL |
| Tudo devolve `401` mesmo com tudo certo | Token copiado com erro (espaço/aspas) ou da outra key | `chmod 600 .env`; reescreve os valores de raiz; valida com `/1/members/me` |
| `429` | Rate limit | Espera ~10 s; reduz chamadas; lê os headers `x-rate-limit-*` |

---

## FAQ

**Dá para gerar a key sem criar uma app? Está a pedir Iframe Connector URL!**
Não dá — desde a reformulação do portal, a API key **só existe dentro de uma app registada** (a
página antiga `trello.com/app-key` foi descontinuada e redireciona para lá). Mas repara: essa
"app" é apenas um **contentor de credenciais** — é grátis, não tem revisão, não se publica, não se
instala em nenhum board e não aparece a ninguém. O Iframe Connector URL **não é obrigatório**: no
formulário **New**, o primeiro campo pergunta *"My app will/doesn't use Power-up capabilities"* →
escolhe **"My app doesn't use Power-Up capabilities"** e o campo do iframe nem sequer aparece
(podes confirmar na [documentação oficial](https://developer.atlassian.com/cloud/trello/guides/power-ups/managing-apps)).
Se já criaste a app na opção errada, cria outra com a escolha certa — a key sai igual.

**Quanto custa?** Nada — a API do Trello é grátis e o plano Free chega. Só pagas se usares a API
STT da OpenAI (opcional).

**Posso usar o mesmo token em vários projetos?** Podes (o token é da tua conta), mas cada projeto
comprometido compromete a conta inteira. Para isolamento, conta de serviço por projeto.

**E se eu usar dois boards?** O `.env` guarda um `TRELLO_BOARD_ID`; para trocar, muda o valor e
reinicia o servidor.

**O token "never" é perigoso?** Só se vazar. Com `.env` fora do git + `chmod 600` + HTTPS, o risco
é o mesmo de qualquer credencial de servidor. Preferes expirar? Usa `30days` e marca no calendário
o dia de renovar (o app avisa-te com `401 invalid token`).

**Porque é que o app diz "modo demo"?** Faltam `TRELLO_API_KEY`, `TRELLO_API_TOKEN` ou
`TRELLO_BOARD_ID` (ou o servidor não foi reiniciado). `curl -s localhost:8787/api/status` diz
exatamente o que falta.

---

## Fontes principais

- App Admin Portal / Managing Apps — <https://developer.atlassian.com/cloud/trello/guides/power-ups/managing-apps>
- Get started with Trello's REST API — <https://support.atlassian.com/trello/docs/getting-started-with-trello-rest-api>
- Authorization (key/token, escopos, expiração, revogação) — <https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization>
- Status Codes — <https://developer.atlassian.com/cloud/trello/guides/rest-api/status-codes>
- Rate Limits — <https://developer.atlassian.com/cloud/trello/guides/rest-api/rate-limits>
- Revoke a Trello token — <https://support.atlassian.com/trello/docs/revoking-a-trello-token>
- Object Definitions (shortLink) — <https://developer.atlassian.com/cloud/trello/guides/rest-api/object-definitions>
- Changelog (OAuth 2.0, 15/09/2026) — <https://developer.atlassian.com/cloud/trello/changelog>
- TRELLO-1769 (mensagem `missing scopes` enganadora) — <https://jira.atlassian.com/browse/TRELLO-1769>
- TRELLO-1770 (id validado antes da autenticação) — <https://jira.atlassian.com/browse/TRELLO-1770>
- OWASP CWE-598 (credenciais em query string) — <https://community.owasp.org/vulnerabilities/Information_exposure_through_query_strings_in_url>

*Dossiê de pesquisa completo (evidência, citações literais, verificação adversarial):
[`pesquisas/trello-setup-api.md`](../pesquisas/trello-setup-api.md).*
