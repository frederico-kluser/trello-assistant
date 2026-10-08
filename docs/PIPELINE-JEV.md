# Pipeline JEV 2.0 — cascata intenção → colunas → cards agrupados (compostos → Gemini)

> Desenho do novo pipeline de decisão do Trello Orbit. Substitui o modelo antigo
> (1 chamada com `query_kind` + fallback MiMo 2.6 Pro) por uma cascata simples:
> **classificar a intenção (CRUD) → filtrar colunas → filtrar cards, em lotes**.
> **Comandos compostos** (várias ações numa fala) vão para o System Two —
> `google/gemini-3.8-flash` — que planeja o comando inteiro. O System Two também
> fica reservado para geração de texto em criação/edição ("motivações"), que
> **ainda não entra** nesta fase.
>
> **Nesta revisão**: o pre-router determinístico passou a mandar ao System Two
> também as **buscas por características** (além dos comandos com 2+ cláusulas),
> e a última listagem ficou acionável por comando seguinte — ver §11.

---

## 1. O que muda (e porquê)

| Antes | Agora | Porquê |
|---|---|---|
| 1 chamada JEV decide intenção, card, lista, `query_kind`, guardas | 1 chamada decide intenção **CRUD**, card, lista, guardas **+ 1 pergunta `noul` por coluna** | perguntas do mesmo pedido correm em paralelo no modelo e "adding more questions does not create context-rot" ([docs.typesafe.ai/primitives](https://docs.typesafe.ai/primitives)) — o portão de colunas sai de graça na mesma chamada |
| Consultas só sabiam responder `overview` e `list_contents`; o resto ia para o MiMo | **Toda** consulta de listagem passa pela cascata colunas → cards: o JEV avalia cada card e decide se deve ser listado | é o pedido do utilizador: "o JEV roda para todos os cards não-arquivados e vê se o que eu peço é para aquele card ser listado ou não" |
| MiMo 2.6 Pro assumia quando o JEV se abstinha | **Sem fallback genérico** — abstenção/indisponibilidade → pedir esclarecimento. **Exceção: comandos compostos** (2+ ações numa fala) vão para o Gemini 3.8 Flash planejar tudo | erro grave só pode ser ação errada; abster e perguntar é seguro, mas comandos simultâneos são o caso legítimo do System Two |
| Cards avaliados como opções de um `choice` (teto de 255, forçado a escolher um) | Cards avaliados em **lotes de 16**, **1 `noul` por card** (pointwise, nunca listwise) | padrão consolidado do mercado (jgrep: 16/pedido; PlotVeil: 20/pedido; "Count in code; ask one Noul per item"); `choice` tem probabilidades que somam 1 e não tem sinal de "nenhum" ([semantic_find](https://docs.typesafe.ai/cookbooks/semantic_find)) |

## 2. O pipeline

```
fala → STT → splitClauses (≤4 cláusulas, em paralelo)
                │
                ▼
   ┌────────────────────────────────────────────────┐
   │ FASE 1 — 1 chamada JEV por cláusula            │
   │  intent  (choice) → classe CRUD + ação fina    │
   │  card    (choice) → alvo em CRUD               │
   │  list    (choice) → destino/local              │
   │  compound·clear·pronoun (noul) → guardas       │
   │  col_0..col_n (noul) → portão de COLUNAS       │
   └────────────────────────────────────────────────┘
                │
      intent = listar_cards?
        │sim                    │não (criar/editar/mover/deletar)
        ▼                       ▼
   ┌──────────────────┐   ação montada por CÓDIGO
   │ FASE 2 — colunas │   (título, datas e texto
   │  p ≥ 0,35 passa  │    extraídos deterministicamente;
   │  nenhuma? → todas│    bandas auto/hitl como hoje;
   └──────────────────┘    criar/apagar sempre confirmam)
        │
        ▼
   ┌──────────────────────────────────┐
   │ FASE 3 — cards em LOTES de 16    │
   │  1 chamada JEV por lote          │
   │  1 noul por card ("listar?")     │
   │  lotes em paralelo (pool de 8)   │
   └──────────────────────────────────┘
        │
        ▼
   fala determinística + plan.listing (+ trace.listing)
```

- **Intenção = listagem** cobre tudo o que é consulta: "o que eu tenho para
  fazer?", "o que há em fazendo?", "quais cards vencem esta semana?", "procura o
  card do contador" — a cascata de relevância responde a todas sem taxonomia de
  `query_kind`. "Me dá um resumo do board" (`resumo_board`) continua a ser
  respondido por código (`describeBoard`), sem cascata.
- **Uma cláusula por decisão**: «lista o que tenho e apaga o contador» divide-se
  como hoje; a cláusula de listagem corre a cascata, a outra monta a ação.
- **Comandos compostos → Gemini**: ver §6.

## 3. Fase 1 — classificação da intenção (CRUD)

A classificação define **se é listagem, edição, criação, movimentação ou
deleção** — cada opção do `choice` pertence a uma destas classes:

| Opção (`id`) | Classe | Notas |
|---|---|---|
| `listar_cards` | **listagem** | listar/mostrar/procurar cards que correspondem a algo |
| `resumo_board` | **listagem** | "resumo do board", "como está o quadro" → `describeBoard` |
| `criar_card` · `create_list` | **criação** | texto do card/lista vem de código |
| `move_card` | **movimentação** | exige lista destino |
| `rename_card` · `comment_card` · `set_due` · `remove_due` · `mark_done` · `add_checklist_item` | **edição** | texto/datas de código |
| `delete_card` · `archive_card` | **deleção** | sempre com confirmação |
| `other` | **outro** | abstenção (`not_a_command`) |

As restantes perguntas da fase 1 ficam como estão (`card`, `list`, `compound`,
`clear`, `pronoun`), incluindo as regras de banda (`JEV_AUTO_THRESHOLD=0.80`,
`JEV_HITL_THRESHOLD=0.50`, guardas `clear`/`compound`, ajuda `lexicalCard`,
pronome → sempre `hitl`). `query_kind` **desaparece**.

**Portão de colunas** (na mesma chamada): 1 pergunta `noul` por lista aberta,
id `col_<i>`:

> «A consulta do utilizador pode ter resposta entre os cards da coluna
> «\<nome\>» (\<N\> cards; ex.: \<até 3 títulos\>)?»
> criteria: `true` "A coluna pode conter cards que respondem ao pedido, ou o
> pedido fala dela" · `false` "A coluna não tem relação com o pedido"

Regra (recall-first — o 1º estágio define o teto de recall e o 2º não recupera o
que foi cortado, [arXiv 2609.27953](https://arxiv.org/html/2609.27953v1)):

- coluna passa se `p ≥ JEV_COL_INCLUDE` (padrão **0,35** — critério largo, com
  "em caso de dúvida, considere que PODE conter" na rubrica);
- **a poda é pulada** — e passam todas as colunas (`gateNote` no trace) —
  quando: (a) a consulta é **temporal** (atrasado/vence/prazo/semana/…): os
  prazos espalham-se por colunas e a resposta não vive numa coluna só; (b) o
  board é **pequeno** (≤ 2 lotes de cards abertos): a poda poupa ~nada e só
  arrisca recall;
- **se nenhuma passar, passam todas** (`fallbackColumns: true`): o filtro fino
  por card é que decide; nunca se perde um card por causa do estágio grosso.

## 4. Fases 2+3 — cascata de listagem e agrupamento de cards

**Candidatos**: cards não-arquivados das colunas aprovadas, na ordem do board
(lista por `pos`, card por `pos`).

**Lotes**: `JEV_CARD_BATCH` cards por chamada (padrão **16**, clamp 4–24;
evidência: jgrep=16, PlotVeil=20, BatchPrompt mostra degradação a partir de
~16–32 — [arXiv 2309.00384](https://arxiv.org/abs/2309.00384)). Os lotes correm
em paralelo com um pool de 8 (`Promise` limitado), dentro do rate limit do
endpoint (80 req/s).

**Cada chamada de lote**:

- `state` **idêntico em todos os lotes** (prefixo estável — cache e menos
  *context rot*, que é do `state`, [concepts/state](https://docs.typesafe.ai/concepts/state)):
  `{ comando, quadro, listas }` (nomes + contagens). Os dados dos cards vivem
  nas perguntas, não no `state`.
- `questions`: **1 `noul` por card** (pointwise; nunca 1 `choice` com cards como
  opções):

> instructions: «Este pedido é uma consulta ao quadro. O card «\<nome\>»
> (coluna: \<lista\>[; etiquetas: …][; prazo: …][; descrição: …])
> deve ser LISTADO na resposta ao pedido? \<GUARD\>»
> criteria: `true` "O card responde ou corresponde ao pedido (em pedidos sobre
> prazos, use o campo `prazo`: ATRASADO / vence HOJE / vence em N dias)" ·
> `false` "O card nada tem a ver com o pedido (ex.: prazo que não corresponde)"

  A linha do card é compacta: nome (≤100 chars), coluna, nomes de etiquetas,
  **prazo relativo determinístico** (`ATRASADO (venceu …)` · `vence HOJE` ·
  `vence amanhã` · `vence em N dias` · `concluído` — as datas ficam no código;
  o JEV só julga a semântica) e excerto de descrição (≤120 chars, só se
  existir) — alvo ~30–60 tokens/card.

**Limiares (assimétricos por risco — listar é read-only, falso negativo é pior
que falso positivo)**:

| `p` (P(listar)) | Decisão |
|---|---|
| `≥ JEV_LIST_INCLUDE` (0,50) | **listado** |
| `≥ JEV_LIST_MAYBE` (0,35) | **listado com ressalva** ("talvez") — nunca escondido |
| `< 0,35` | não listado |

**Saída** (falada por código, o JEV não gera texto): agrupada por coluna —
«Em A Fazer: X, Y. Em Fazendo: Z.» + «Talvez também: W.» — com teto de ~12
itens falados e «e mais N»; se nada passar: «Não encontrei nada que
correspondesse ao pedido.»

## 5. Contrato (trace / plan / API)

```js
plan: {
  speech, actions: [], needsConfirmation: false,
  band: "auto",                       // listagem nunca confirma
  listing: [{ id, name, list, due, maybe }],   // só em listagem
}

trace.jev.listing: {
  columns: [Decision…],               // id col_<i>, label "Coluna «X»", type noul
  cards:   [Decision…],               // id c_<j>, label "Card «X»", maybe: bool
  kept: ["A Fazer"], pruned: ["Feito"], fallbackColumns: false,
  gateNote: null,                     // "temporal" | "board-pequeno" | "nenhuma" | null
  batches: 3, evaluated: 40, listed: 7, maybe: 2,
}
```

`Decision` continua `{id,label,type,value,display,confidence,band,p?,top?}`.
`trace.clauses[].decisions` mantém-se, **sem** `query_kind`. O envelope do
`/api/agent` não muda; `trace.mimo`/`trace.fallback` ficam sempre `null`
(a UI passa a usar `plan.warning` para o banner). Planos do System Two
(compostos) vêm com `provider: "llm"`, `band: null`, `trace.jev: null` e
`trace.llm: {status, model, latencyMs}`.

## 6. Comandos compostos → System Two (e sem fallback genérico)

- **Deteção de comandos simultâneos** (em `planner.js`): `splitClauses` devolve
  > 1 cláusula, OU o JEV dispara a guarda `compound` num trecho único → o
  comando **inteiro** vai para o System Two (`google/gemini-3.8-flash`,
  `services/agent.js`), que devolve o plano multi-ação
  (`{speech, actions[], needsConfirmation}`, `provider: "llm"`, `band: null`,
  `trace.llm`). É ele que resolve menções borradas de voz («a atividade da
  academia» → GYM, «Ondocay» → Ondokai) e pronomes entre cláusulas.
- Falha do System Two num composto → cai no fluxo JEV por cláusulas (que ainda
  resolve compostos limpos); se também abstiver → esclarecimento.
- **Restantes abstenções** (`unclear`, `low_card`, `no_card`…) e JEV
  indisponível → `planCommand` responde com `actions: []`, `band: "abstain"`,
  `warning: <motivo>` e fala de esclarecimento («Não consigo operar: … Pode
  reformular?») — **sem** LLM.
- **Nada** assume o plano às cegas. Criar/apagar continuam a confirmar sempre
  (`requiresConfirmation`), inclusive vindos do System Two.
- Sem chave OpenRouter (modo sem chaves), o interpretador local pt-BR continua a
  manter o app vivo (`provider: "local"`).
- O System Two fica também reservado para geração de texto (nome/descrição/
  "motivações") em criar/editar — **futuro**, não implementado agora.

## 7. Configuração nova

| Env | Padrão | O que é |
|---|---|---|
| `JEV_CARD_BATCH` | 16 | cards por chamada na cascata (clamp 4–24) |
| `JEV_LIST_INCLUDE` | 0,50 | `p` mínimo para listar o card |
| `JEV_LIST_MAYBE` | 0,35 | `p` mínimo para listar com ressalva |
| `JEV_COL_INCLUDE` | 0,35 | `p` mínimo para a coluna passar (largo, recall-first) |

`JEV_AUTO_THRESHOLD`/`JEV_HITL_THRESHOLD` mantêm-se para as decisões de CRUD.

## 8. Qualidade do agrupamento (porque 16 e não 200)

O ganho de "13 perguntas numa chamada ≈ 12× mais barato" ([cookbook parallel
questions](https://docs.typesafe.ai/cookbooks/parallel_questions)) **não** se
aplica a meter N cards no mesmo `state`: cada card é lido uma vez nos dois
cenários — o agrupamento é **neutro em tokens, ganha latência/requests** e só
arrisca qualidade se o `state` crescer com ruído. Daí as travas:

1. **Pointwise** (1 `noul` por card) — imune ao *unselection bias* do formato
   "seleciona todos" (EM ~40% no SATA-Bench,
   [arXiv 2506.00643](https://arxiv.org/html/2506.00643v1)).
2. **Lote ≤ 24** — degradação medida acima de ~16–32 itens
   ([BatchPrompt](https://arxiv.org/abs/2309.00384)); default 16.
3. **`state` mínimo e estável** — *context rot* é do `state`, não do nº de
   perguntas (documentação oficial TypeSafe).
4. **Recall-first** — colunas com critério largo + ressalva "talvez" em vez de
   esconder; o único erro grave de listagem seria omitir um card que interessa.
5. **Limiares por risco** — listar (read-only) inclui a partir de 0,5; ações
   mutantes mantêm auto/hitl + confirmação obrigatória em criar/apagar.

## 9. Custos e latência (ordem de grandeza)

- CRUD: 1 chamada ≈ 0,3–0,4 s (igual a hoje).
- Listagem de 40 cards: 1 chamada de fase 1 + 3 lotes ≈ 4–5k tokens ≈
  **US$ 0,0002** e **2 idas de rede** (~0,7–1 s com socket quente).
- 1000 cards ≈ US$ 0,03–0,04 por varrimento completo (estimativa dos dossiês).

## 10. Validação

- `npm test` (server): unitários do pipeline novo (perguntas, portão de colunas,
  lotes, limiares, fala de listagem, ausência de fallback).
- `npm run eval:jev`: casos reais sobre o board demo, incluindo listagens com
  `listingIncludes`/`listingExcludes`; **exit 1** se alguma ação errada OU
  algum card esperado faltar na listagem. Rodar sempre que mudar as perguntas.
- Cobertura nova em `server/test/`: `model-picker.test.js` (escolha `auto`,
  tetos de preço, fallback, cache), `search-engine.test.js` (texto + filtros),
  `session-store.test.js` (TTL/LRU/última pesquisa) e `orchestration.test.js`
  (pre-router, `@lastSearch`, multi-ações).

## 11. Pre-router determinístico e busca por características (`search_cards`)

O fluxo continua **JEV-first**: o JEV faz o grosso e o pre-router só antecipa dois
casos para o System Two.

```
fala → splitClauses → pre-router determinístico (isCharacteristicSearch)
         │
         ├─ 2+ cláusulas (ou guarda compound) ──┐
         ├─ busca por características ──────────┤
         │                                      ▼
         │                         System Two (LLM, §6)
         │                         {"type":"search_cards", …}
         │                         → plan.listing + search {query, count}
         │
         └─ resto → JEV (fase 1 → 2 → 3, §2)
                      └─ abstain / indisponível → esclarecimento, sem fallback genérico
```

- **System Two primeiro — 2+ cláusulas**: `splitClauses` devolve > 1 cláusula, ou
  o JEV dispara a guarda `compound` num trecho único; o comando **inteiro** vai ao
  System Two, que devolve **todas** as ações na ordem falada (regra 6 do prompt) —
  inclusive ações **heterogêneas** (editar descrição + marcar prazo + comentar, em
  cards distintos). É o §6, sem mudanças de contrato.
- **System Two primeiro — busca por características**: o pre-router determinístico
  (`isCharacteristicSearch`) reconhece pedidos do tipo *«quais atividades têm
  comentários sobre pagamento?»* e manda o comando ao System Two, que emite a ação
  de **leitura** `search_cards`. Quem a executa é `services/planner.js`, contra
  `services/search-engine.js`: busca por texto em **nome + descrição + comentários
  + etiqueta + lista** (termos em **AND**, texto normalizado — acentos, pontuação e
  emoji —, com *score*) combinada com filtros estruturais (lista, etiquetas
  **TODAS**, prazo `any|set|none|overdue|today|week`, arquivados). O resultado sai
  no payload SSE como `listing` + `search: {query, count}` e **nunca confirma**
  (read-only).
- **JEV para o resto**: qualquer comando que não caia nos dois casos acima segue o
  pipeline normal (§2–§4), incluindo CRUD e as listagens por cascata.
- **Abstenção não mudou**: `abstain`/indisponível → `actions: []` + `warning` +
  pedido de reformulação, **sem fallback genérico** (§6).
- **Última pesquisa acionável** (transversal aos dois caminhos): toda listagem —
  busca ou cascata — grava os ids no *session-store* (`services/session-store.js`,
  TTL **6 h**, LRU **500** sessões); o comando seguinte pode dizer *«essas
  atividades»*/*«os da última pesquisa»* e o planner expande `@lastSearch` em **N
  ações concretas**, com avisos **distintos** para "sem pesquisa anterior" e
  "pesquisa vazia".

## 12. Fontes (dossiês Tavily, 2026)

- TypeSafe docs — [primitives](https://docs.typesafe.ai/primitives) ·
  [state](https://docs.typesafe.ai/concepts/state) ·
  [parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions) ·
  [semantic find](https://docs.typesafe.ai/cookbooks/semantic_find) ·
  [confidence routing](https://docs.typesafe.ai/patterns/confidence-routing)
- BatchPrompt (ICLR 2024) — https://arxiv.org/abs/2309.00384 · Lost in the
  Middle (TACL 2024) — https://arxiv.org/abs/2307.03172
- SATA-Bench (listwise é frágil) — https://arxiv.org/html/2506.00643v1 ·
  Dichotomic prompting (pointwise = 1 decisão binária por item) —
  https://arxiv.org/html/2511.03830v1
- Recall ceiling de reranking (o 1º estágio define o teto) —
  https://arxiv.org/html/2609.27953v1
- OpenRouter cookbook (1 item/pedido é o contra-exemplo; lotes reais 16–20) —
  https://openrouter.ai/docs/cookbook/evaluate-and-optimize/jev-classification
- FrugalGPT/cascatas — https://arxiv.org/html/2502.00409v3 ·
  Culpepper SIGIR 2017 (cost-aware cascade)
- Trello API: `filter=visible` ≠ `filter=open` (cards de listas arquivadas) —
  https://developer.atlassian.com/cloud/trello/guides/rest-api/nested-resources
