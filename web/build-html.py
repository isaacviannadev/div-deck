# Fills the page template with the shared favicon/logo and writes docs/index.html.
import pathlib
root = pathlib.Path(__file__).parent
s = (root / 'index.template.html').read_text()
parts = {k: (root / 'parts' / f'{k}.html').read_text().strip() for k in ['FAVICON', 'LOGO', 'WARN']}
for k, v in parts.items():
    s = s.replace('{{' + k + '}}', v)
(root.parent / 'docs' / 'index.html').write_text(s)
print('docs/index.html written')
