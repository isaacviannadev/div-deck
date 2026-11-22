# DIV Deck

Macro pad 3×5 com ESP32, teclas MX hot-swap e LED RGB por tecla — e o app que configura tudo, para **macOS** e **Windows**.

**Página e downloads:** https://isaacviannadev.github.io/div-deck/

## Repositório

| Pasta | O que é |
|---|---|
| `app/` | App de controle (Tauri 2 + React/TypeScript). Perfis por app, atalhos, mídia, links, textos, comandos, cores dos LEDs. |
| `firmware/` | Firmware do ESP32 (PlatformIO/Arduino). Protocolo serial texto a 115200. |
| `docs/` | Página do produto (GitHub Pages) — destino do QR code da embalagem. |
| `.github/workflows/release.yml` | Gera os instaladores (`.dmg` universal e `setup.exe`) ao criar uma tag `v*`. |

## Desenvolver o app

```sh
cd app
npm install
npm run tauri dev      # app completo
npm run dev            # só a interface no navegador, com dados de exemplo
```

No macOS, se o projeto estiver num disco externo, compile com `CARGO_TARGET_DIR=~/Library/Caches/divdeck-target` (o macOS cria arquivos `._*` em discos exFAT que quebram o build).

## Publicar uma versão

1. Atualize a versão em `app/src-tauri/tauri.conf.json`, `app/src-tauri/Cargo.toml` e `app/package.json`.
2. `git tag v0.2.0 && git push origin v0.2.0`
3. O GitHub Actions gera os instaladores e publica a release. A página pega sempre a mais recente.

## Firmware

```sh
cd firmware
pio run -t upload
```

Protocolo: o host envia `HELLO`, `PING` (a cada 2 s), `L k rrggbb`, `A rrggbb`, `P rrggbb`, `B 0-96`, `S`; o deck envia `D k` / `U k`. Sem host por 5 s, entra em modo autônomo (teclas “respirando” nas cores salvas).

© DIV Tecnologia. Todos os direitos reservados.
