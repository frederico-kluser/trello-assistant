# 🪐 Trello Orbit

**Pilote seu board do Trello por voz.** Você fala → a API STT da OpenAI transcreve → o
**MiMo 2.6 Pro** (OpenRouter) entende e planeja → o app confirma com você, executa pela API do
Trello e responde **em áudio**, enquanto os cards dançam em órbita ao redor do botão de record.

> Microfone no centro, cards orbitando por anéis inspirados em Júpiter: o card que você menciona
> vem **para perto**, ganha destaque e a ação só acontece depois da sua confirmação.

---

## Índice

- [O que ele faz](#o-que-ele-faz)
- [Início rápido (sem nenhuma chave)](#início-rápido-sem-nenhuma-chave)
- [Configuração completa (.env)](#configuração-completa-env)
- [Credenciais passo a passo](#credenciais-passo-a-passo)
- [Comandos de voz](#comandos-de-voz)
- [API do servidor](#api-do-servidor)
- [Design, animações e acessibilidade](#design-animações-e-acessibilidade)
- [Estrutura do repositório](#estrutura-do-repositório)
- [Testes e verificação](#testes-e-verificação)
- [Publicação sem vazar credenciais](#publicação-sem-vazar-credenciais)
- [Segurança](#segurança)
- [Solução de problemas](#solução-de-problemas)
- [Licença](#licença)

---

## O que ele faz

### Fluxo completo

1. **Você toca o botão de record** (o "planeta" central) e fala o que quer.
2. O áudio vai para o servidor e é transcrito pela **API STT da OpenAI**
   (`gpt-4o-mini-transcribe` por padrão, `whisper-1` opcional).
3. A transcrição vai para o **OpenRouter**, modelo **`xiaomi/mimo-v2.6-pro`** com
   **esforço de raciocínio no máximo** (`reasoning: { effort: "max" }`), junto com um
   snapshot do seu board — ele devolve um **plano JSON** de ações + a frase que o app vai falar.
4. O app **anuncia em áudio** o que vai fazer. Para **criar** ou **apagar**, ele **pede confirmação**
   (modal com hold-to-confirm para exclusão). Para mover/prazo/comentar, executa direto.
5. O servidor aplica as ações na **API REST v1 do Trello** (ou num board demo) e o app responde em
   áudio, com toasts e animação nos cards.

Tudo isso funciona **sem nenhuma chave configurada**: o app degrada com elegância
(STT do navegador · interpretador local pt-BR · board de demonstração) e mostra no painel exatamente
o que falta configurar.

### Ações suportadas na API do Trello

| Ação | Com a voz | Confirmação? |
|---|---|---|
| Criar card (nome, lista, descrição, prazo, etiquetas) | «cria card X na lista Y com prazo amanhã» | ✅ sempre |
| Apagar card (definitivo) | «apaga o card X» | ✅ sempre (hold-to-confirm) |
| Mover card entre listas | «move X para fazendo» | não (narra e executa) |
| Editar card (nome, descrição, etiquetas) | «renomeia X para Y» / «coloca etiqueta urgente em X» | não |
| Definir/remover prazo (+ concluir prazo) | «coloca prazo sexta no card X» | não |
| Comentar no card | «comenta revisado no card X» | não |
| Arquivar card | «arquiva o card X» | não |
| Criar lista | «cria lista chamada Espera» | não |
| Adicionar item a checklist | «adiciona revisar contrato ao checklist de X» | não |
| Consultar o board | «o que eu tenho para fazer?» | — (só responde) |

O servidor também expõe **`GET /api/trello/boards`** (lista seus boards, útil para achar o
`TRELLO_BOARD_ID`) e trata erros da API do Trello com códigos claros
(`trello_unauthorized`, `trello_not_found`, …).

---

## Início rápido (sem nenhuma chave)

Requisitos: **Node.js 20+** e npm.

```bash
# 1) dependências
cd server && npm install
cd ../web  && npm install && npm run build

# 2) configuração (pode deixar tudo em branco — modo demo)
cd .. && cp .env.example .env

# 3) subir
cd server && npm start
# ✦ Trello Orbit · http://localhost:8787
```

Abra <http://localhost:8787> — você já verá o board de demonstração em órbita e poderá falar ou
digitar comandos. Nada fica rodando depois que você dá `Ctrl+C`.

Para desenvolver o front com hot reload: `cd web && npm run dev` (Vite na porta 5173, com proxy
para a API em `:8787`).

---

## Configuração completa (.env)

Tudo vive em **um único arquivo** (`/.env`), lido **só pelo servidor**. O `.env.example` documenta
cada campo:

| Variável | O que faz | Onde obter |
|---|---|---|
| `PORT` | porta do servidor (padrão `8787`) | — |
| `APP_URL` / `APP_NAME` | atribuição enviada ao OpenRouter | — |
| `OPENAI_API_KEY` | transcrição de voz (STT) | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| `OPENAI_STT_MODEL` | `gpt-4o-mini-transcribe` (padrão), `gpt-4o-transcribe` ou `whisper-1` | — |
| `OPENAI_STT_LANGUAGE` | idioma da transcrição (padrão `pt`) | — |
| `OPENROUTER_API_KEY` | análise da fala com o MiMo | [openrouter.ai/keys](https://openrouter.ai/keys) |
| `OPENROUTER_MODEL` | padrão `xiaomi/mimo-v2.6-pro` | — |
| `OPENROUTER_REASONING_EFFORT` | esforço de raciocínio: `max` (padrão) · `xhigh` · `high` · `medium` · `low` · `minimal` · `none` | — |
| `OPENROUTER_MAX_TOKENS` | teto de saída (inclui reasoning tokens), padrão `16000` | — |
| `OPENROUTER_MAX_PROMPT_PRICE` / `..._COMPLETION_PRICE` | teto de custo opcional (USD por 1M tokens) | — |
| `TRELLO_API_KEY` | chave da API do Trello | [trello.com/power-ups/admin](https://trello.com/power-ups/admin) |
| `TRELLO_API_TOKEN` | token com escopo `read, write` | gerado pelo link "Token" no mesmo painel |
| `TRELLO_BOARD_ID` | qual board controlar | `GET /api/trello/boards` |

**Nenhuma dessas variáveis chega ao navegador.** O front conversa apenas com `/api/*`.

---

## Credenciais passo a passo

**➡️ Tutorial completo guiado (com links, `curl`, troubleshooting e segurança):**
**[`docs/TRELLO-GUIA-COMPLETO.md`](docs/TRELLO-GUIA-COMPLETO.md)** — baseado em pesquisa profunda
com verificação adversarial (evidência em [`pesquisas/trello-setup-api.md`](pesquisas/trello-setup-api.md)).

Guia visual complementar: **[`docs/PROXIMOS-PASSOS.html`](docs/PROXIMOS-PASSOS.html)**.

Resumo do Trello (a parte manual):

1. [trello.com/power-ups/admin](https://trello.com/power-ups/admin) → **New** → dê um nome (ex.: *Trello Orbit*).
2. Menu **API Key** → **Generate a new API key** → isso é o `TRELLO_API_KEY`.
3. Link **Token** logo abaixo → autorize com escopo **read, write** → isso é o `TRELLO_API_TOKEN`.
4. Com key + token no `.env`, chame `curl "http://localhost:8787/api/trello/boards"` e copie o `id`
   do board desejado para `TRELLO_BOARD_ID`.
5. Reinicie o servidor — o selo "modo demo" some do cabeçalho.

---

## Comandos de voz

O agente (MiMo) entende linguagem natural. O interpretador local de fallback cobre a gramática
essencial em pt-BR:

| Fale algo como | Resultado |
|---|---|
| «cria um card chamado comprar cabo hdmi na lista a fazer com prazo amanhã» | cria (com confirmação) |
| «apaga o card revisar proposta» | apaga (com confirmação + hold) |
| «move revisar proposta para fazendo» | move |
| «coloca prazo sexta no card revisar proposta» | define prazo |
| «comenta revisado no card revisar proposta» | comenta |
| «arquiva o card comprar cabo hdmi» | arquiva |
| «cria uma lista chamada Espera» | cria lista |
| «o que eu tenho para fazer?» | resume o board em áudio |

Datas aceitas: *hoje, amanhã, depois de amanhã, semana que vem, sexta(-feira), dia 20, 20/08,
20 de agosto*, com ou sem hora (*«às 18h»*).

> A caixa de texto abaixo do botão aceita os mesmos comandos — alternativa permanente à voz
> (e a razão de o app ser 100% utilizável sem microfone).

---

## API do servidor

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/api/health` | liveness |
| `GET` | `/api/status` | capacidades ativas + checklist do que falta configurar |
| `GET` | `/api/board` | snapshot normalizado do board (Trello ou demo) |
| `POST` | `/api/stt` | multipart `audio` → transcrição (OpenAI STT) |
| `POST` | `/api/agent` | `{ transcript }` → plano `{ speech, actions[], needsConfirmation }` |
| `POST` | `/api/actions` | `{ actions[], confirmed }` → executa; **428** se criar/apagar sem `confirmed: true` |
| `GET` | `/api/trello/boards` | lista boards (para achar o `TRELLO_BOARD_ID`) |

Contrato de erro estável em todas as rotas:

```json
{ "error": { "code": "missing_openai_key", "message": "…", "hint": "…", "detail": null } }
```

---

## Design, animações e acessibilidade

- **Órbita 3D de verdade**: cada lista é um anel inclinado (66°, quase de canto como os de Júpiter),
  com fragmentos de arco, moonlets e cards que giram sempre de pé (contra-rotação sincronizada).
- **Card referenciado vem para perto**: `translateZ` + escala + brilho na borda (beam animado) +
  foco no painel de voo.
- **Criar** = nasce desfocado e cresce com bloom + **confete**; **apagar** = dissolve com blur;
  **mover** = desliza entre anéis.
- **Record como planeta**: pulsos com o nível real do microfone (Web Audio `AnalyserNode`),
  waveform ao gravar, estados claros (gravando/transcrevendo/pensando/executando/falando).
- **Motion UI** (motion.dev): componentes `overlay`, `toast-stack`, `confetti`, `border-beam`,
  `hold-to-confirm`, `multi-state-button` do registry `@motion`, com tokens do `motion.theme.ts`
  (springs `snap/ui/gentle/lively/ambient`). Sem framer-motion; só `motion/react`.
- **Tema shadcn semântico** (paleta espaço profundo + cobre de Júpiter): componentes só usam
  classes semânticas (`bg-card`, `text-primary`…), os valores vivem em `web/src/index.css`.
- **Responsivo**: mobile = 3 anéis + cards maiores para toque (escala mínima 0.55) e modal em
  bottom-sheet; desktop = 5 anéis e painel lateral.
- **Acessibilidade**: `prefers-reduced-motion` respeitado (órbita congela, tudo continua legível),
  `aria-live` para o estado do fluxo, labels SR-only, foco preso no modal, alvos de toque ≥ 44 px,
  contraste AA nos tokens.
- **Feedback em 4 canais coerentes**: fala (TTS pt-BR), plano em texto, toasts e leitor de tela.

---

## Estrutura do repositório

```
trello-assistant/
├── README.md
├── LICENSE                    # MIT
├── .env.example               # única fonte de variáveis (sem valores reais)
├── docs/
│   ├── PROXIMOS-PASSOS.html   # o que fazer depois de clonar (chaves, deploy, checklist)
│   └── UX-AUDIT.json          # auditoria UX/UI (framework de 195 princípios)
├── server/                    # proxy de credenciais + API
│   ├── src/
│   │   ├── index.js           # Express + estático (web/dist) + /docs
│   │   ├── config.js          # lê .env, capacidades, checklist de setup
│   │   ├── lib/http.js        # fetch com retry + Retry-After
│   │   ├── lib/errors.js      # contrato de erros
│   │   ├── domain/actions.js  # schema de ações + resolução de referências
│   │   └── services/
│   │       ├── stt.js         # OpenAI /v1/audio/transcriptions
│   │       ├── agent.js       # OpenRouter xiaomi/mimo-v2.6-pro (plano JSON)
│   │       ├── intent.js      # interpretador local pt-BR (fallback)
│   │       └── trello.js      # REST v1 + board demo em memória
│   └── test/                  # testes do domínio e do parser (node --test)
└── web/                       # front React + Vite + Tailwind + Motion
    └── src/
        ├── App.tsx            # fluxo: voz → plano → confirmação → execução
        ├── components/        # OrbitBoard, VoiceCore, TaskCard, ConfirmDialog…
        ├── hooks/useRecorder.ts
        ├── lib/               # api.ts, speech.ts, types.ts
        └── index.css          # design tokens (shadcn semantics)
```

---

## Testes e verificação

```bash
# backend: 17 testes (domínio, resolução de referências, parser pt-BR)
cd server && npm test

# sintaxe de todos os módulos
cd server && npm run check

# front: type-check + build de produção
cd web && npm run build
```

A auditoria UX/UI do design construído está em [`docs/UX-AUDIT.json`](docs/UX-AUDIT.json)
(195 princípios, score 77/100 — as correções prioritárias já foram aplicadas no código).

---

## Publicação sem vazar credenciais

1. `.env` está no `.gitignore` — o repositório pode ser **púbico**.
2. Suba `server/` em qualquer Node host (Render, Railway, Fly.io, VPS): build do front
   (`cd web && npm install && npm run build`) + `npm start` — o servidor já serve o `web/dist`.
3. Preencha as variáveis **no painel do provedor** (mesmos nomes do `.env.example`).
4. **HTTPS é obrigatório** para o microfone fora de `localhost`.
5. Rode o checklist de verificação em [`docs/PROXIMOS-PASSOS.html`](docs/PROXIMOS-PASSOS.html).

---

## Segurança

- **Chaves só no servidor** — o bundle do front nunca recebe nenhuma credencial.
- **Confirmação obrigatória em dois níveis** para criar/apagar: modal no front **e** trava no
  servidor (`428 confirmation_required` se chamarem `/api/actions` sem `confirmed: true`).
- **Custo controlado**: retries com backoff honrando `Retry-After`, timeouts, e teto de preço
  opcional por request no OpenRouter.
- **Tokens revogáveis**: Trello (painel de Power-Ups), OpenRouter e OpenAI (painéis de cada um).

---

## Solução de problemas

| Sintoma | Causa provável | Correção |
|---|---|---|
| `missing_openai_key` no STT | `OPENAI_API_KEY` vazio/sem saldo | preencha a chave ou use o fallback do navegador |
| App em "modo demo" | `TRELLO_*` não preenchido | siga [docs/PROXIMOS-PASSOS.html](docs/PROXIMOS-PASSOS.html) |
| `trello_unauthorized` | key/token inválidos ou revogados | gere novos em [trello.com/power-ups/admin](https://trello.com/power-ups/admin) |
| `trello_not_found` | `TRELLO_BOARD_ID` errado | `curl "localhost:8787/api/trello/boards"` e copie o `id` |
| Microfone não pede permissão | página sem HTTPS (fora de localhost) | publique com TLS |
| Agente respondeu em JSON inválido | modelo fora do protocolo | o servidor degrada para o interpretador local e avisa no painel |
| 429 do OpenRouter | rate limit | o servidor já retenta com backoff; aguarde ou configure fallback de modelo |

---

## Licença

[MIT](LICENSE) — use, mude e publique à vontade.

Feito com OpenAI STT · OpenRouter (Xiaomi MiMo 2.6 Pro) · API REST do Trello · Motion UI.