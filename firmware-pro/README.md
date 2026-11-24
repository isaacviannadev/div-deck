# DIV Deck Pro — firmware

ESP32-S3 SuperMini + tela de 4" MSP4021 (ST7796S, toque XPT2046). As 15 teclas são quadrados desenhados
na tela (5 × 3). O app DIV Deck (0.2 ou mais novo) manda a cor, o nome e o símbolo de cada uma; tocar num
quadrado funciona como apertar uma tecla do DIV Deck MX.

## Ligações (um jumper por pino, sem emendas — firmware 0.3.1+)

| Tela, pino | Nome | ESP32-S3 SuperMini |
|---:|---|---|
| 1 | VCC | 5V |
| 2 | GND | GND |
| 3 | CS | 10 |
| 4 | RESET | 8 |
| 5 | DC/RS | 9 |
| 6 | SDI (MOSI) | 11 |
| 7 | SCK | 12 |
| 8 | LED | 7 |
| 9 | SDO (MISO) | livre |
| 10 | T_CLK | 4 |
| 11 | T_CS | 3 |
| 12 | T_DIN | 5 |
| 13 | T_DO | 6 |
| 14 | T_IRQ | livre |

O toque tem o seu próprio barramento SPI (pinos 4, 5, 6), por isso nenhum pino do ESP32 leva dois fios.

## Gravar

**Sem instalar nada:** no Chrome ou Edge abra https://espressif.github.io/esptool-js/ , ligue a placa no
USB-C, clique em Connect, endereço `0x0`, escolha `DIVDeckPro_firmware_0.6.1_completo.bin` e Program.
Se a porta não aparecer: segure BOOT, toque em RST e solte BOOT.

**Com PlatformIO:** abra esta pasta e clique em Upload.

## O que deve acontecer

Logo "DIV Deck Pro" por um instante e depois 15 quadrados coloridos (demonstração). Com o app aberto, os
quadrados passam a mostrar o perfil ativo e o LED da SuperMini fica verde.

## Se algo der errado

- Cores invertidas: `INVERT_COLOURS true` em `src/main.cpp`. Vermelho e azul trocados: `SWAP_RGB true`.
- De cabeça para baixo: no app, deck selecionado → "Tela invertida (180°)".
- Toque deslocado: mande as coordenadas dos 4 cantos (programa de teste da Sentinela) para ajustar `x_min/x_max/y_min/y_max`.
