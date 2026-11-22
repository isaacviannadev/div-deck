# DIV Deck — app de controle (macOS)

App Tauri 2 + React/TypeScript que conversa com o DIV Deck (ESP32) pela USB serial.

- Detecta o deck sozinho (CP210x / CH340 / FTDI), reconecta se desplugar.
- 15 teclas por perfil: abrir app, atalho de teclado, mídia/volume, link, digitar texto, comando shell, trocar de perfil.
- Cor do LED por tecla (preview ao vivo), brilho, gravar cores na flash do deck.
- Perfis vinculados a apps: o deck troca sozinho conforme o app em foco.
- Fica na barra de menus; fechar a janela não encerra.

## Compilar (uma vez)

```sh
# Rust (se ainda não tiver)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source ~/.cargo/env

cd app
npm install
npm run tauri build        # gera src-tauri/target/release/bundle/macos/DIV Deck.app e um .dmg
```

Para desenvolver: `npm run tauri dev`. Só a interface no navegador (dados de exemplo): `npm run dev`.

## Permissões

Atalhos, mídia e texto usam eventos de teclado → **Ajustes do Sistema › Privacidade e Segurança › Acessibilidade** → ativar *DIV Deck*. O app avisa e abre a tela certa.
Se o app não for assinado, na primeira vez: botão direito no .app › Abrir.

## Protocolo (firmware)

`HELLO` / `PING` a cada 2 s / `L k rrggbb` / `A rrggbb` / `P rrggbb` / `B 0-96` / `S` — o deck envia `D k` e `U k`.
Configuração salva em `~/Library/Application Support/com.divtecnologia.divdeck/config.json`.
