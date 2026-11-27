# DIV Deck site: design

Dark product story (the owner preferred it over the light "print plate" experiment, Nov 2026).

- Colours: black #000 / #0a0a0c sections, cards #111114, line #1f1f24, text #f5f5f7 / #a1a1a6 / #6e6e73,
  accent #2997ff, cyan #38d6ff, violet #7c5cff. "Em breve" amber #ffb020.
- Type: system UI (SF Pro on Apple), tight tracking on big headings.
- Hero: a pinned three.js scene; the scroll drives the camera and the chapters
  (hero, keys, inside/exploded, light, swappable faces/covers, profiles). Model switch MX / Touch.
- Faces: pictures of the real printed faces/covers (docs/assets/faces) laid on the 3D parts.
- Sections: models (MX, Touch, Pro em breve) with faces and covers, start, features, profiles,
  download + waitlist (mailto contato@divtecnologia.com.br), FAQ.

## Fotos dos modelos e embalagens

- Os cards de MX e Touch usam fotos de cenário em 4:3 (`docs/img/mx.webp` e `docs/img/touch.webp`). As faces decorativas ficam recolhidas até o leitor expandir as opções.
- A seção Dentro da caixa, após os modelos, traz três vistas por produto em `docs/img/embalagens/`. As fotos são ilustrativas; o Touch tem tela desligada e caneta no berço superior, e face extra, suporte de mesa, suporte de tubo e cabo USB-C na bandeja de acessórios.
- O GLB do Touch (`docs/assets/divdeck-pro.glb`, nome legado) usa as malhas v6: traseira com pegas, moldura por cima e pé de mesa v2. Os dois modelos usam a geometria lisa sem texturas de faces no início da animação.
